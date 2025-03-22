use chrono::{DateTime, Local, NaiveDate, Timelike};
use poise::serenity_prelude as serenity;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::time;
use poise::serenity_prelude::GatewayIntents;

// Define the structure for standup entries
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StandupEntry {
    user_id: String,
    display_name: String,
    did: String,
    plan: String,
    blockers: String,
    timestamp: DateTime<Local>,
}

// Define our bot's state
#[derive(Clone)]
struct Data {
    standup_entries: Arc<Mutex<Vec<StandupEntry>>>,
    summary_channel_id: Arc<Mutex<Option<serenity::ChannelId>>>,
    summary_time: Arc<Mutex<(u32, u32)>>, // (hour, minute) in 24-hour format
    last_summary_date: Arc<Mutex<Option<NaiveDate>>>, // Using NaiveDate instead of deprecated Date<Local>
}

type Error = Box<dyn std::error::Error + Send + Sync>;
type Context<'a> = poise::Context<'a, Data, Error>;

#[tokio::main]
async fn main() {
    // Load environment variables from .env file
    dotenv::dotenv().ok();

    // Get the Discord token from environment variables
    let token = std::env::var("DISCORD_TOKEN").expect("Missing DISCORD_TOKEN");

    let intents = GatewayIntents::GUILDS
        | GatewayIntents::GUILD_MESSAGES
        | GatewayIntents::MESSAGE_CONTENT;

    // Create the framework
    let framework = poise::Framework::builder()
        .options(poise::FrameworkOptions {
            commands: vec![standup(), set_summary_channel(), set_summary_time(), trigger_summary()],
            ..Default::default()
        })
        .token(token)
        .intents(intents)
        .setup(|ctx, _ready, framework| {
            Box::pin(async move {
                poise::builtins::register_globally(ctx, &framework.options().commands).await?;
                
                // Load any saved data
                let data = load_data().await;
                
                // Start the scheduled task for sending summary
                let ctx_clone = ctx.clone();
                let data_clone = data.clone();
                tokio::spawn(async move {
                    schedule_summary_task(ctx_clone, data_clone).await;
                });
                
                println!("Bot successfully started!");
                Ok(data)
            })
        });

    // Start the bot
    framework.run().await.unwrap();
}

// Load saved data from disk or create default data
async fn load_data() -> Data {
    if let Ok(file) = fs::read_to_string("bot_data.json") {
        if let Ok(saved) = serde_json::from_str::<SavedData>(&file) {
            return Data {
                standup_entries: Arc::new(Mutex::new(saved.standup_entries)),
                summary_channel_id: Arc::new(Mutex::new(saved.summary_channel_id)),
                summary_time: Arc::new(Mutex::new(saved.summary_time.unwrap_or((17, 0)))), // Default 5:00 PM
                last_summary_date: Arc::new(Mutex::new(saved.last_summary_date)),
            };
        }
    }
    
    println!("No saved data found or could not load data. Starting with defaults.");
    
    // Default data if nothing is loaded
    Data {
        standup_entries: Arc::new(Mutex::new(Vec::new())),
        summary_channel_id: Arc::new(Mutex::new(None)),
        summary_time: Arc::new(Mutex::new((17, 0))), // Default 5:00 PM
        last_summary_date: Arc::new(Mutex::new(None)),
    }
}

#[derive(Serialize, Deserialize)]
struct SavedData {
    standup_entries: Vec<StandupEntry>,
    summary_channel_id: Option<serenity::ChannelId>,
    summary_time: Option<(u32, u32)>,
    last_summary_date: Option<NaiveDate>, // Using NaiveDate which is serializable
}

// Save data to disk
async fn save_data(data: &Data) -> Result<(), Error> {
    let entries = data.standup_entries.lock().await.clone();
    let channel_id = *data.summary_channel_id.lock().await;
    let summary_time = *data.summary_time.lock().await;
    let last_summary_date = *data.last_summary_date.lock().await;
    
    let saved_data = SavedData {
        standup_entries: entries,
        summary_channel_id: channel_id,
        summary_time: Some(summary_time),
        last_summary_date,
    };
    
    let json = serde_json::to_string_pretty(&saved_data)
        .map_err(|e| format!("Failed to serialize data: {}", e))?;
    
    fs::write("bot_data.json", json)
        .map_err(|e| format!("Failed to write data file: {}", e))?;
    
    println!("Data saved successfully");
    Ok(())
}

// Schedule the task to send daily summaries
async fn schedule_summary_task(ctx: serenity::Context, data: Data) {
    println!("Starting summary scheduler");
    
    // Use a shorter interval for checking the time to avoid missing the target time
    let check_interval = Duration::from_secs(60); // Check every minute
    
    loop {
        // Get the current time and the scheduled summary time
        let now = Local::now();
        let (target_hour, target_minute) = *data.summary_time.lock().await;
        
        // Send summary if we're in the target time window
        let should_send = now.hour() == target_hour && 
                          now.minute() >= target_minute && 
                          now.minute() < target_minute + 5; // 5-minute window
        
        if should_send {
            println!("It's time for the summary! Current time: {}:{:02}", now.hour(), now.minute());
            
            // Send the summary with all current entries
            if let Err(e) = send_summary(&ctx, &data).await {
                eprintln!("Error sending summary: {}", e);
            } else {
                println!("Summary sent successfully");
            }
            
            // Wait a bit more than the check window to avoid duplicate summaries within the same hour
            time::sleep(Duration::from_secs(360)).await; // 6 minutes
        } else {
            // Wait for the next check interval
            time::sleep(check_interval).await;
        }
    }
}

// Send the summary and clear the stack
async fn send_summary(ctx: &serenity::Context, data: &Data) -> Result<(), Error> {
    let channel_id_option = *data.summary_channel_id.lock().await;

    let channel_id = match channel_id_option {
        Some(id) => id,
        None => return Err("No summary channel set.".into()),
    };
    
    // Create a snapshot of entries to avoid holding the lock during message sending
    let entries_snapshot = {
        let entries = data.standup_entries.lock().await;
        if entries.is_empty() {
            println!("No standup entries to summarize.");
            return Ok(());
        }
        entries.clone()
    };
    
    // Group entries by user
    let mut user_entries: HashMap<String, Vec<StandupEntry>> = HashMap::new();
    for entry in entries_snapshot.iter() {
        user_entries
            .entry(entry.user_id.clone())
            .or_insert_with(Vec::new)
            .push(entry.clone());
    }

    // Create the summary message
    let mut message = "# Daily Standup Summary\n\n".to_string();

    for (_, user_entries) in user_entries.iter() {
        // Use the most recent entry for each user
        if let Some(latest) = user_entries.iter().max_by_key(|e| e.timestamp) {
            message.push_str(&format!("## {}\n", latest.display_name));
            message.push_str(&format!("**Did:** {}\n", latest.did));
            message.push_str(&format!("**Plan:** {}\n", latest.plan));
            message.push_str(&format!("**Blockers:** {}\n\n", latest.blockers));
        }
    }

    // Send the message with retry logic
    let mut retries = 3;
    let mut last_error = None;
    
    while retries > 0 {
        match channel_id.say(ctx, &message).await {
            Ok(_) => {
                // Clear the entries only after successful sending
                let mut entries = data.standup_entries.lock().await;
                entries.clear();
                drop(entries); // Release the lock
                
                // Save the updated data
                if let Err(e) = save_data(data).await {
                    eprintln!("Failed to save data after clearing entries: {}", e);
                }
                
                return Ok(());
            }
            Err(e) => {
                eprintln!("Error sending summary (retries left: {}): {:?}", retries - 1, e);
                last_error = Some(format!("Discord API error: {:?}", e));
                retries -= 1;
                time::sleep(Duration::from_secs(5)).await; // Wait before retrying
            }
        }
    }
    
    Err(last_error.unwrap_or_else(|| "Failed to send summary after multiple attempts".into()).into())
}
#[poise::command(slash_command, ephemeral)]
/// Submit your daily standup update
async fn standup(
    ctx: Context<'_>,
    #[description = "What you did"] did: String,
    #[description = "What you plan to do"] plan: String,
    #[description = "Any blockers or problems"] blockers: String,
) -> Result<(), Error> {
    let user = ctx.author();
    
    // Get the user's display name (nickname if available, otherwise username)
    let display_name = if let Some(member) = ctx.author_member().await {
        member.nick.clone().unwrap_or_else(|| user.name.clone())
    } else {
        user.name.clone()
    };
    
    // Create a new standup entry
    let entry = StandupEntry {
        user_id: user.id.to_string(),
        display_name,
        did,
        plan,
        blockers,
        timestamp: Local::now(),
    };
    
    // Add the entry to our stack
    {
        let mut entries = ctx.data().standup_entries.lock().await;
        
        // Remove any previous entries from the same user (keep only latest)
        entries.retain(|e| e.user_id != user.id.to_string());
        
        // Add the new entry
        entries.push(entry);
        
        // Release the lock before saving
        drop(entries);
    }
    
    // Save the updated data
    if let Err(e) = save_data(ctx.data()).await {
        eprintln!("Failed to save data after standup submission: {}", e);
        ctx.say("Your standup has been recorded, but there was an error saving the data.").await?;
    } else {
        ctx.say("Your standup has been recorded. Thanks!").await?;
    }
    
    Ok(())
}

#[poise::command(slash_command, ephemeral)]
/// Set the channel for daily summaries
async fn set_summary_channel(
    ctx: Context<'_>,
    #[description = "The channel for daily summaries"] channel_id: serenity::ChannelId,
) -> Result<(), Error> {
    // Check if the command is being used in a server
    let guild_id = match ctx.guild_id() {
        Some(id) => id,
        None => {
            ctx.say("This command can only be used in a server.").await?;
            return Ok(());
        }
    };

    // Fetch the guild to get the owner ID
    let guild = match ctx.http().get_guild(guild_id.0).await {
        Ok(guild) => guild,
        Err(e) => {
            println!("Failed to fetch guild information: {:?}", e);
            ctx.say("Failed to fetch guild information. Please try again later.").await?;
            return Ok(());
        }
    };

    // Check if the user is the server owner or has the "Manage Channels" permission
    let is_owner = ctx.author().id == guild.owner_id;
    let has_permission = ctx.author_member().await
        .map_or(false, |member| member.permissions(ctx).map_or(false, |p| p.manage_channels()));

    if !is_owner && !has_permission {
        ctx.say("You need 'Manage Channels' permission to use this command.").await?;
        return Ok(());
    }

    // Verify that the channel exists and is accessible
    match channel_id.to_channel(&ctx).await {
        Ok(_) => {
            // Set the summary channel ID in the shared data
            *ctx.data().summary_channel_id.lock().await = Some(channel_id);

            // Save the updated data
            if let Err(e) = save_data(ctx.data()).await {
                eprintln!("Failed to save data after setting summary channel: {}", e);
                ctx.say("Summary channel set, but there was an error saving the configuration.").await?;
                return Ok(());
            }

            // Notify the user
            ctx.say(format!("Summary channel set to <#{}>", channel_id)).await?;
        }
        Err(_) => {
            ctx.say("Invalid channel or I don't have access to it.").await?;
        }
    }

    Ok(())
}

#[poise::command(slash_command, ephemeral)]
/// Set the time when daily summaries will be sent (24-hour format)
async fn set_summary_time(
    ctx: Context<'_>,
    #[description = "Hour (0-23)"] hour: u32,
    #[description = "Minute (0-59)"] minute: u32,
) -> Result<(), Error> {
    // Check if the user has permission to manage channels
    if let Some(member) = ctx.author_member().await {
        if !member.permissions(ctx).map_or(false, |p| p.manage_channels()) {
            ctx.say("You need 'Manage Channels' permission to use this command.").await?;
            return Ok(());
        }
    }
    
    // Validate hour and minute
    if hour > 23 || minute > 59 {
        ctx.say("Invalid time. Hour must be between 0-23 and minute between 0-59.").await?;
        return Ok(());
    }
    
    // Set the summary time
    *ctx.data().summary_time.lock().await = (hour, minute);
    
    // Save the updated data
    if let Err(e) = save_data(ctx.data()).await {
        eprintln!("Failed to save data after setting summary time: {}", e);
        ctx.say("Summary time set, but there was an error saving the configuration.").await?;
        return Ok(());
    }
    
    ctx.say(format!("Summary time set to {:02}:{:02}", hour, minute)).await?;
    
    Ok(())
}

#[poise::command(slash_command, ephemeral)]
/// Manually trigger a standup summary (admin only)
async fn trigger_summary(
    ctx: Context<'_>,
) -> Result<(), Error> {
    // Check if the user has permission to manage channels
    if let Some(member) = ctx.author_member().await {
        if !member.permissions(ctx).map_or(false, |p| p.manage_channels()) {
            ctx.say("You need 'Manage Channels' permission to use this command.").await?;
            return Ok(());
        }
    } else {
        ctx.say("This command can only be used in a server.").await?;
        return Ok(());
    }
    
    ctx.say("Manually triggering standup summary...").await?;
    
    // Send the summary
    match send_summary(&ctx.serenity_context().clone(), ctx.data()).await {
        Ok(_) => {
            // Update the last summary date
            *ctx.data().last_summary_date.lock().await = Some(Local::now().date_naive());
            if let Err(e) = save_data(ctx.data()).await {
                eprintln!("Failed to save data after manual summary: {}", e);
            }
            
            ctx.say("Summary sent successfully!").await?;
        },
        Err(e) => {
            ctx.say(format!("Failed to send summary: {}", e)).await?;
        }
    }
    
    Ok(())
}