use chrono::{DateTime, Local, Timelike};
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
            commands: vec![standup(), set_summary_channel(), set_summary_time()],
            ..Default::default()
        })
        .token(token)
        .intents(intents)
        // .intents(serenity::GatewayIntents::non_privileged() | serenity::GatewayIntents::MESSAGE_CONTENT)
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
            };
        }
    }
    
    // Default data if nothing is loaded
    Data {
        standup_entries: Arc::new(Mutex::new(Vec::new())),
        summary_channel_id: Arc::new(Mutex::new(None)),
        summary_time: Arc::new(Mutex::new((17, 0))), // Default 5:00 PM
    }
}

#[derive(Serialize, Deserialize)]
struct SavedData {
    standup_entries: Vec<StandupEntry>,
    summary_channel_id: Option<serenity::ChannelId>,
    summary_time: Option<(u32, u32)>,
}

// Save data to disk
async fn save_data(data: &Data) {
    let entries = data.standup_entries.lock().await.clone();
    let channel_id = *data.summary_channel_id.lock().await;
    let summary_time = *data.summary_time.lock().await;
    
    let saved_data = SavedData {
        standup_entries: entries,
        summary_channel_id: channel_id,
        summary_time: Some(summary_time),
    };
    
    if let Ok(json) = serde_json::to_string_pretty(&saved_data) {
        let _ = fs::write("bot_data.json", json);
    }
}

// Schedule the task to send daily summaries
async fn schedule_summary_task(ctx: serenity::Context, data: Data) {
    loop {
        // Get the current time and the scheduled summary time
        let now = Local::now();
        let (hour, minute) = *data.summary_time.lock().await;
        
        // Calculate when to send the next summary
        let mut next_summary = now;
        if now.hour() > hour || (now.hour() == hour && now.minute() >= minute) {
            // If we've already passed today's summary time, schedule for tomorrow
            next_summary = next_summary.with_hour(0).unwrap().with_minute(0).unwrap() + chrono::Duration::days(1);
        }
        
        next_summary = next_summary.with_hour(hour).unwrap().with_minute(minute).unwrap();
        
        // Calculate the duration until the next summary
        let duration_until_summary = next_summary.signed_duration_since(now);
        let seconds_until_summary = duration_until_summary.num_seconds().max(0) as u64;
        
        // Wait until it's time to send the summary
        time::sleep(Duration::from_secs(seconds_until_summary)).await;
        
        // Send the summary
        send_summary(&ctx, &data).await;
        
        // Sleep for a minute to avoid potential multiple triggers
        time::sleep(Duration::from_secs(60)).await;
    }
}

// Send the summary and clear the stack
async fn send_summary(ctx: &serenity::Context, data: &Data) {
    let channel_id_option = *data.summary_channel_id.lock().await;
    
    if let Some(channel_id) = channel_id_option {
        let mut entries = data.standup_entries.lock().await;
        
        if !entries.is_empty() {
            // Group entries by user
            let mut user_entries: HashMap<String, Vec<StandupEntry>> = HashMap::new();
            
            for entry in entries.iter() {
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
            
            // Send the message
            match channel_id.say(ctx, message).await {
                Ok(_) => {
                    println!("Summary sent successfully.");
                }
                Err(e) => {
                    eprintln!("Error sending summary: {:?}", e);
                }
            }
            
            // Clear the entries
            entries.clear();
            
            // Save the updated data
            drop(entries); // Release the lock before saving
            save_data(data).await;
        } else {
            println!("No standup entries to summarize.");
        }
    } else {
        println!("No summary channel set.");
    }
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
        entries.push(entry);
        
        // Save the updated data
        drop(entries); // Release the lock before saving
        save_data(ctx.data()).await;
    }
    
    ctx.say("Your standup has been recorded. Thanks!").await?;
    
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
            save_data(ctx.data()).await;

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
    save_data(ctx.data()).await;
    
    ctx.say(format!("Summary time set to {:02}:{:02}", hour, minute)).await?;
    
    Ok(())
}