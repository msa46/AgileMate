import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, TextChannel, PermissionFlagsBits, ButtonBuilder, ButtonStyle, ActionRowBuilder, ButtonInteraction, ComponentType, Message, User, GuildMember } from 'discord.js';
import { CronJob } from 'cron';
import { ConvexClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';

// Set up Convex client
const convex = new ConvexClient(process.env.CONVEX_URL || '');

// Store active cron jobs
const scheduledJobs = new Map<string, CronJob>();

export const data = new SlashCommandBuilder()
  .setName('standup')
  .setDescription('Manage daily standup reminders')
  .addSubcommand(subcommand =>
    subcommand
      .setName('join')
      .setDescription('Opt in to daily standup reminders')
      .addChannelOption(option =>
        option
          .setName('channel')
          .setDescription('Channel where summary should be posted (must have permission)')
          .setRequired(true)))
  .addSubcommand(subcommand =>
    subcommand
      .setName('leave')
      .setDescription('Opt out of daily standup reminders'))
  .addSubcommand(subcommand =>
    subcommand
      .setName('list')
      .setDescription('List all users who have joined standup reminders')
      .addBooleanOption(option =>
        option
          .setName('show_responses')
          .setDescription('Show today\'s responses so far')
          .setRequired(false)));

export const execute = async (interaction: ChatInputCommandInteraction) => {
  const subcommand = interaction.options.getSubcommand();
  const guildId = interaction.guildId!;
  
  switch (subcommand) {
    case 'join':
      await handleJoin(interaction);
      break;
    case 'leave':
      await handleLeave(interaction);
      break;
    case 'list':
      await handleList(interaction);
      break;
    default:
      await interaction.reply({
        content: 'Unknown subcommand. Please use join, leave, or list.',
        ephemeral: true
      });
  }
};

// Handle the join subcommand
const handleJoin = async (interaction: ChatInputCommandInteraction) => {
  const userId = interaction.user.id;
  const guildId = interaction.guildId!;
  const channel = interaction.options.getChannel('channel', true);
  
  // Check if channel is a text channel
  if (channel.type !== 0) { // 0 is GUILD_TEXT 
    return interaction.reply({
      content: 'Please select a text channel for the standup summary.',
      ephemeral: true
    });
  }
  
  // Check if the user has permission to send messages in the channel
  const member = interaction.member as GuildMember;
  const textChannel = channel as TextChannel;
  
  const permissions = textChannel.permissionsFor(member);
  if (!permissions?.has(PermissionFlagsBits.SendMessages)) {
    return interaction.reply({
      content: `You don't have permission to send messages in ${channel}. Please select a different channel.`,
      ephemeral: true
    });
  }
  
  try {
    // Add user to standup list in Convex
    await convex.mutation(api.standupFunctions.addStandupUser, {
      userId,
      guildId,
      channelId: channel.id
    });
    
    await interaction.reply({
      content: `You've been added to daily standup reminders. You'll receive a reminder at 9 AM daily, and a summary will be posted in ${channel} at 9 PM.`,
      ephemeral: true
    });
    
    // Schedule jobs if they don't exist for this guild
    scheduleJobs(interaction.client, guildId);
  } catch (error) {
    console.error('Error adding user to standups:', error);
    await interaction.reply({
      content: 'There was an error setting up your standup reminders. Please try again later.',
      ephemeral: true
    });
  }
};

// Handle the leave subcommand
const handleLeave = async (interaction: ChatInputCommandInteraction) => {
  const userId = interaction.user.id;
  const guildId = interaction.guildId!;
  
  try {
    // Check if user is in standup list
    const user = await convex.query(api.standupFunctions.getStandupUser, {
      userId,
      guildId
    });
    
    if (!user) {
      return interaction.reply({
        content: 'You are not currently signed up for standup reminders.',
        ephemeral: true
      });
    }
    
    // Remove user from standup list
    await convex.mutation(api.standupFunctions.removeStandupUser, {
      userId,
      guildId
    });
    
    await interaction.reply({
      content: 'You have been removed from daily standup reminders.',
      ephemeral: true
    });
    
    // Check if there are any users left in this guild
    const remainingUsers = await convex.query(api.standupFunctions.getStandupUsers, {
      guildId
    });
    
    // If no users left, remove the cron jobs
    if (remainingUsers.length === 0) {
      const morningJobKey = `${guildId}_morning`;
      const eveningJobKey = `${guildId}_evening`;
      
      if (scheduledJobs.has(morningJobKey)) {
        scheduledJobs.get(morningJobKey)!.stop();
        scheduledJobs.delete(morningJobKey);
      }
      
      if (scheduledJobs.has(eveningJobKey)) {
        scheduledJobs.get(eveningJobKey)!.stop();
        scheduledJobs.delete(eveningJobKey);
      }
    }
  } catch (error) {
    console.error('Error removing user from standups:', error);
    await interaction.reply({
      content: 'There was an error removing you from standup reminders. Please try again later.',
      ephemeral: true
    });
  }
};

// Handle the list subcommand
const handleList = async (interaction: ChatInputCommandInteraction) => {
  const guildId = interaction.guildId!;
  const showResponses = interaction.options.getBoolean('show_responses') || false;
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
  
  try {
    // Get all users in the guild who have joined standup
    const users = await convex.query(api.standupFunctions.getStandupUsers, {
      guildId
    });
    
    if (users.length === 0) {
      return interaction.reply({
        content: 'No users have joined standup reminders in this server.',
        ephemeral: true
      });
    }
    
    let content = '**Users in daily standup:**\n';
    
    // Fetch today's responses if needed
    let responses = [];
    if (showResponses) {
      responses = await convex.query(api.standupFunctions.getStandupResponsesByDate, {
        guildId,
        date: today
      });
    }
    
    // Defer reply to handle potential timeout with larger servers
    await interaction.deferReply({ ephemeral: true });
    
    // Build user list with responses if requested
    for (const user of users) {
      try {
        const channel = interaction.client.channels.cache.get(user.channelId) as TextChannel;
        const fetchedUser = await interaction.client.users.fetch(user.userId);
        content += `- ${fetchedUser.tag} (reports to <#${user.channelId}>)\n`;
        
        if (showResponses) {
          const userResponse = responses.find((r: { userId: string }) => r.userId === user.userId);
          
          if (userResponse) {
            content += `  **Done:** ${userResponse.done || 'No response'}\n`;
            content += `  **Doing:** ${userResponse.doing || 'No response'}\n`;
            content += `  **Blockers:** ${userResponse.blockers || 'No response'}\n\n`;
          } else {
            content += `  *Has not submitted standup today*\n\n`;
          }
        }
      } catch (error) {
        console.error(`Error processing user ${user.userId}:`, error);
        content += `- User ID: ${user.userId} (Unable to fetch details)\n`;
      }
    }
    
    // Follow up with the content (already deferred)
    await interaction.followUp({
      content,
      ephemeral: true
    });
  } catch (error) {
    console.error('Error listing standup users:', error);
    
    // Handle based on whether we've already deferred
    if (interaction.deferred) {
      await interaction.followUp({
        content: 'There was an error fetching the standup list. Please try again later.',
        ephemeral: true
      });
    } else {
      await interaction.reply({
        content: 'There was an error fetching the standup list. Please try again later.',
        ephemeral: true
      });
    }
  }
};

// Schedule the morning and evening jobs for a guild
const scheduleJobs = (client, guildId: string) => {
  const morningJobKey = `${guildId}_morning`;
  const eveningJobKey = `${guildId}_evening`;
  
  // Skip if jobs already exist
  if (scheduledJobs.has(morningJobKey) && scheduledJobs.has(eveningJobKey)) {
    return;
  }
  
  // Remove old jobs if they exist
  if (scheduledJobs.has(morningJobKey)) {
    scheduledJobs.get(morningJobKey)!.stop();
    scheduledJobs.delete(morningJobKey);
  }
  
  if (scheduledJobs.has(eveningJobKey)) {
    scheduledJobs.get(eveningJobKey)!.stop();
    scheduledJobs.delete(eveningJobKey);
  }
  
  // Morning job - 9 AM daily
  const morningJob = new CronJob('0 9 * * *', () => {
    sendMorningReminders(client, guildId);
  });
  
  // Evening job - 9 PM daily
  const eveningJob = new CronJob('0 21 * * *', () => {
    sendEveningSummary(client, guildId);
  });
  
  morningJob.start();
  eveningJob.start();
  
  scheduledJobs.set(morningJobKey, morningJob);
  scheduledJobs.set(eveningJobKey, eveningJob);
  
  console.log(`Scheduled standup jobs for guild ${guildId}`);
};

// Send morning reminders to all users who have opted in
const sendMorningReminders = async (client, guildId: string) => {
  try {
    const users = await convex.query(api.standupFunctions.getStandupUsers, {
      guildId
    });
    
    if (users.length === 0) return;
    
    console.log(`Sending morning reminders to ${users.length} users in guild ${guildId}`);
    
    // Send reminder to each user
    for (const userData of users) {
      try {
        const user = await client.users.fetch(userData.userId);
        await sendStandupPrompt(user, guildId);
      } catch (error) {
        console.error(`Failed to send standup reminder to user ${userData.userId}:`, error);
      }
    }
  } catch (error) {
    console.error(`Error sending morning reminders for guild ${guildId}:`, error);
  }
};

// Send standup prompt to a user
const sendStandupPrompt = async (user: User, guildId: string) => {
  const embed = new EmbedBuilder()
    .setTitle('📝 Daily Standup Reminder')
    .setDescription('Please provide your standup update by clicking the button below.')
    .setColor('#00FF00')
    .setTimestamp();
  
  const button = new ButtonBuilder()
    .setCustomId(`standup_${guildId}`)
    .setLabel('Provide Update')
    .setStyle(ButtonStyle.Primary);
  
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);
  
  try {
    const message = await user.send({
      embeds: [embed],
      components: [row]
    });
    
    // Collect button interaction
    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 12 * 60 * 60 * 1000 // 12 hours
    });
    
    collector.on('collect', async (interaction: ButtonInteraction) => {
      const clickedGuildId = interaction.customId.split('_')[1];
      await interaction.reply('Please answer the following questions in the same channel:');
      await collectStandupResponses(user, interaction, clickedGuildId);
    });
  } catch (error) {
    console.error(`Failed to send DM to user ${user.tag}:`, error);
  }
};

// Collect standup responses via DM
const collectStandupResponses = async (user: User, interaction: ButtonInteraction, guildId: string) => {
  const questions = [
    '**What did you accomplish yesterday/today?**',
    '**What will you work on today/tomorrow?**',
    '**Are there any blockers or challenges?**'
  ];
  
  const responses: string[] = [];
  
  for (const question of questions) {
    await user.send(question);
    
    try {
      // Wait for message in DM
      const responseCollection = await interaction.channel?.awaitMessages({
        filter: m => m.author.id === user.id,
        max: 1,
        time: 5 * 60 * 1000, // 5 minutes
        errors: ['time']
      });
      
      if (responseCollection && responseCollection.first()) {
        responses.push(responseCollection.first()!.content);
      } else {
        responses.push('No response');
      }
    } catch (error) {
      responses.push('No response (timed out)');
    }
  }
  
  // Store responses in Convex
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  
  try {
    await convex.mutation(api.standupFunctions.submitStandupResponse, {
      userId: user.id,
      guildId,
      date: today,
      done: responses[0] || 'No response',
      doing: responses[1] || 'No response',
      blockers: responses[2] || 'No response'
    });
    
    await user.send('Thank you for submitting your standup update! Your responses have been recorded and will be included in the evening summary.');
  } catch (error) {
    console.error('Error storing standup response:', error);
    await user.send('There was an error storing your standup update. Please try again later or contact an administrator.');
  }
};

// Send evening summary to designated channels
const sendEveningSummary = async (client, guildId: string) => {
  try {
    // Get today's responses for this guild
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const responses = await convex.query(api.standupFunctions.getStandupResponsesByDate, {
      guildId,
      date: today
    });
    
    if (responses.length === 0) {
      console.log(`No standup responses for guild ${guildId} today`);
      return;
    }
    
    // Get all users in the guild
    const users = await convex.query(api.standupFunctions.getStandupUsers, {
      guildId
    });
    
    if (users.length === 0) return;
    
    console.log(`Sending evening summary for guild ${guildId}`);
    
    // Group responses by channel
    const channelMap = new Map<string, {userId: string, response: any}[]>();
    
    for (const user of users) {
      if (!channelMap.has(user.channelId)) {
        channelMap.set(user.channelId, []);
      }
      
      // Find this user's response
      const response = responses.find(r => r.userId === user.userId);
      if (response) {
        channelMap.get(user.channelId)!.push({
          userId: user.userId,
          response
        });
      }
    }
    
    // Send summary to each channel
    for (const [channelId, userResponses] of channelMap.entries()) {
      try {
        const channel = await client.channels.fetch(channelId) as TextChannel;
        if (!channel) continue;
        
        const embed = new EmbedBuilder()
          .setTitle('📊 Daily Standup Summary')
          .setDescription(`Summary of today's standup updates from team members.`)
          .setColor('#0099FF')
          .setTimestamp();
        
        if (userResponses.length === 0) {
          embed.addFields(
            { name: 'No Updates Today', value: 'No team members have submitted their standup updates today.' }
          );
        } else {
          for (const { userId, response } of userResponses) {
            try {
              const user = await client.users.fetch(userId);
              embed.addFields(
                { name: `${user.tag}`, value: '\u200B' },
                { name: 'Accomplished', value: response.done || 'No response', inline: false },
                { name: 'Working on', value: response.doing || 'No response', inline: false },
                { name: 'Blockers', value: response.blockers || 'No response', inline: false },
                { name: '\u200B', value: '\u200B' } // Spacer
              );
            } catch (error) {
              console.error(`Error fetching user ${userId}:`, error);
              embed.addFields(
                { name: `User ID: ${userId}`, value: '\u200B' },
                { name: 'Accomplished', value: response.done || 'No response', inline: false },
                { name: 'Working on', value: response.doing || 'No response', inline: false },
                { name: 'Blockers', value: response.blockers || 'No response', inline: false },
                { name: '\u200B', value: '\u200B' } // Spacer
              );
            }
          }
        }
        
        await channel.send({ embeds: [embed] });
        
      } catch (error) {
        console.error(`Failed to send standup summary to channel ${channelId}:`, error);
      }
    }
  } catch (error) {
    console.error(`Error sending evening summary for guild ${guildId}:`, error);
  }
};

// Load existing jobs on bot start
export const onReady = async (client) => {
  console.log('Loading standup jobs...');
  
  try {
    // Get all guilds that have standup users
    const guildIds = await convex.query(api.standupFunctions.getAllGuildsWithStandups, {});
    
    for (const guildId of guildIds) {
      scheduleJobs(client, guildId);
    }
    
    console.log(`Scheduled standup jobs for ${guildIds.length} guilds`);
  } catch (error) {
    console.error('Error loading standup jobs:', error);
  }
};