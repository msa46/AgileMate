import { SlashCommandBuilder, ChatInputCommandInteraction, Message, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ButtonInteraction, ComponentType, TextChannel, GuildMember } from 'discord.js';

// Store multiple active polls per server with vote tracking and eligible voters
const activePolls = new Map<string, Map<string, {
  message: Message;
  timeout: NodeJS.Timeout | Timer;
  options: string[];
  votes: Map<string, number>; // Maps user IDs to option indices
  eligibleVoters: Set<string>; // Set of user IDs who can vote
}>>();

export const data = new SlashCommandBuilder()
  .setName('vote')
  .setDescription('Start an anonymous vote')
  .addStringOption(option =>
    option.setName('question')
      .setDescription('The question to vote on')
      .setRequired(true))
  .addStringOption(option =>
    option.setName('options')
      .setDescription('Comma-separated list of options')
      .setRequired(true))
  .addIntegerOption(option =>
    option.setName('duration')
      .setDescription('Duration of the vote in minutes')
      .setRequired(true));

export const execute = async (interaction: ChatInputCommandInteraction) => {
  const question = interaction.options.getString('question', true);
  const options = interaction.options.getString('options', true).split(',').map(opt => opt.trim());
  const duration = interaction.options.getInteger('duration', true) * 60 * 1000; // Convert to milliseconds
  
  if (options.length < 2) {
    return interaction.reply({ content: 'You need to provide at least two options.', ephemeral: true });
  }
  
  if (options.length > 5) {
    return interaction.reply({ content: 'You can only provide up to 5 options for button-based voting.', ephemeral: true });
  }
  
  // Ensure the interaction happened in a text channel
  if (!interaction.channel || interaction.channel.isDMBased()) {
    return interaction.reply({ content: 'This command can only be used in server text channels.', ephemeral: true });
  }
  
  // Create an embed for the poll
  const embed = new EmbedBuilder()
    .setTitle(question)
    .setDescription(options.map((option, index) => `${index + 1}. ${option}`).join('\n'))
    .setColor('#00FF00')
    .setFooter({ text: `Results will be revealed when the poll ends (after ${duration / 60000} minutes or when everyone votes).` });
  
  // Create vote buttons
  const buttons = options.map((option, index) => {
    return new ButtonBuilder()
      .setCustomId(`vote_${index}`)
      .setLabel(`Option ${index + 1}`)
      .setStyle(ButtonStyle.Primary);
  });
  
  // Split buttons into rows of 5 (Discord limit)
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5));
    rows.push(row);
  }
  
  // Send the poll message with buttons
  const message = await interaction.reply({ 
    embeds: [embed], 
    components: rows, 
    fetchReply: true 
  }) as Message;
  
  // Generate a unique poll ID using the message ID
  const pollId = message.id;
  
  // Initialize server's poll map if it doesn't exist
  if (!activePolls.has(interaction.guildId!)) {
    activePolls.set(interaction.guildId!, new Map());
  }
  
  // Get list of eligible voters (members who can see the channel)
  const eligibleVoters = new Set<string>();
  
  try {
    // Get members who can see the channel
    const channel = interaction.channel as TextChannel;
    const members = await channel.guild.members.fetch();
    
    members.forEach((member: GuildMember) => {
      // Skip bots
      if (member.user.bot) return;
      
      // Check if member can view the channel
      if (channel.permissionsFor(member)?.has('ViewChannel')) {
        eligibleVoters.add(member.id);
      }
    });
  } catch (error) {
    console.error('Error fetching channel members:', error);
    // Continue with an empty list if we can't fetch members
  }
  
  // Create a new poll entry with vote tracking
  const serverPolls = activePolls.get(interaction.guildId!)!;
  serverPolls.set(pollId, {
    message,
    options,
    votes: new Map(),
    eligibleVoters,
    timeout: setTimeout(async () => {
      await endPoll(message, pollId, interaction.guildId!);
    }, duration)
  });
  
  // Create a collector for button interactions
  const collector = message.createMessageComponentCollector({ 
    componentType: ComponentType.Button,
    time: duration 
  });
  
  collector.on('collect', async (buttonInteraction: ButtonInteraction) => {
    // Extract the option index from the button ID
    const optionIndex = parseInt(buttonInteraction.customId.split('_')[1]);
    const userId = buttonInteraction.user.id;
    const pollData = serverPolls.get(pollId)!;
    
    // Skip if user is not eligible to vote
    if (pollData.eligibleVoters.size > 0 && !pollData.eligibleVoters.has(userId)) {
      await buttonInteraction.reply({ 
        content: `You don't have permission to vote in this poll.`, 
        ephemeral: true 
      });
      return;
    }
    
    // Record the vote, overwriting any previous vote by this user
    pollData.votes.set(userId, optionIndex);
    
    // Acknowledge the vote without revealing results
    await buttonInteraction.reply({ 
      content: `Your vote for "${options[optionIndex]}" has been recorded. You can change your vote until the poll ends.`, 
      ephemeral: true 
    });
    
    // Check if all eligible voters have voted
    if (pollData.eligibleVoters.size > 0 && 
        pollData.votes.size >= pollData.eligibleVoters.size) {
      // End poll early if everyone has voted
      clearTimeout(pollData.timeout);
      await endPoll(message, pollId, interaction.guildId!);
      collector.stop();
    }
  });
  
  // Log information about eligible voters
  let voterInfoMsg = `Poll created successfully! Poll ID: ${pollId}.`;
  if (eligibleVoters.size > 0) {
    voterInfoMsg += ` There are ${eligibleVoters.size} eligible voters. The poll will end when everyone votes or the time expires.`;
  } else {
    voterInfoMsg += ` Unable to determine eligible voters. The poll will end after the time expires.`;
  }
  
  // Send a confirmation message with poll ID for reference
  await interaction.followUp({ 
    content: voterInfoMsg, 
    ephemeral: true 
  });
};

// Function to end the poll and display results
const endPoll = async (message: Message, pollId: string, guildId: string) => {
  const serverPolls = activePolls.get(guildId);
  if (!serverPolls || !serverPolls.has(pollId)) return;
  
  const pollData = serverPolls.get(pollId)!;
  const { options, votes, eligibleVoters } = pollData;
  
  // Count votes for each option
  const voteCounts = Array(options.length).fill(0);
  votes.forEach((optionIndex) => {
    voteCounts[optionIndex]++;
  });
  
  // Generate results message
  let results = '**Poll Results**\n\n';
  options.forEach((option, index) => {
    results += `${option}: ${voteCounts[index]} votes\n`;
  });
  
  // Find the winner(s)
  const maxVotes = Math.max(...voteCounts);
  const winners = options.filter((_, index) => voteCounts[index] === maxVotes);
  
  if (maxVotes > 0) {
    if (winners.length === 1) {
      results += `\n**Winner**: ${winners[0]} with ${maxVotes} votes!`;
    } else {
      results += `\n**Tie between**: ${winners.join(', ')} with ${maxVotes} votes each!`;
    }
  } else {
    results += "\n**No votes were cast in this poll.**";
  }
  
  // Add participation stats
  if (eligibleVoters.size > 0) {
    const participationRate = (votes.size / eligibleVoters.size * 100).toFixed(1);
    results += `\n\n**Participation**: ${votes.size}/${eligibleVoters.size} eligible members voted (${participationRate}%)`;
  }
  
  // Update the original message to show it's ended
  const endedEmbed = EmbedBuilder.from(message.embeds[0])
    .setColor('#FF0000')
    .setFooter({ text: 'This poll has ended. See results below.' });
  
  await message.edit({ embeds: [endedEmbed], components: [] });
  
  // Send results
  await message.reply({ content: results });
  
  // Remove the poll from active polls
  serverPolls.delete(pollId);
  
  // Clean up the server entry if there are no more polls
  if (serverPolls.size === 0) {
    activePolls.delete(guildId);
  }
};

// Command to end a specific poll manually
export const endData = new SlashCommandBuilder()
  .setName('endpoll')
  .setDescription('End a specific poll manually')
  .addStringOption(option =>
    option.setName('poll_id')
      .setDescription('The ID of the poll to end (leave empty to see active polls)')
      .setRequired(false));

export const endExecute = async (interaction: ChatInputCommandInteraction) => {
  const guildId = interaction.guildId!;
  const pollId = interaction.options.getString('poll_id');
  
  // Check if there are any active polls for this server
  if (!activePolls.has(guildId) || activePolls.get(guildId)!.size === 0) {
    return interaction.reply({ content: 'There are no active polls in this server.', ephemeral: true });
  }
  
  const serverPolls = activePolls.get(guildId)!;
  
  // If no poll ID provided, list all active polls
  if (!pollId) {
    const pollList = Array.from(serverPolls.entries()).map(([id, { message, eligibleVoters, votes }]) => {
      const embed = message.embeds[0];
      const votedCount = votes.size;
      const totalVoters = eligibleVoters.size;
      
      return `**ID**: ${id} - **Question**: ${embed.title} - **Votes**: ${votedCount}/${totalVoters || '?'}`;
    }).join('\n');
    
    return interaction.reply({ 
      content: `**Active Polls:**\n${pollList}\n\nUse \`/endpoll poll_id:<ID>\` to end a specific poll.`, 
      ephemeral: true 
    });
  }
  
  // Check if the specified poll exists
  if (!serverPolls.has(pollId)) {
    return interaction.reply({ 
      content: `No active poll found with ID: ${pollId}`, 
      ephemeral: true 
    });
  }
  
  // End the specified poll
  const pollData = serverPolls.get(pollId)!;
  clearTimeout(pollData.timeout);
  await endPoll(pollData.message, pollId, guildId);
  
  await interaction.reply({ 
    content: `The poll with ID ${pollId} has been ended manually.`, 
    ephemeral: true 
  });
};

// Command to list all active polls
export const listData = new SlashCommandBuilder()
  .setName('listpolls')
  .setDescription('List all active polls in this server');

export const listExecute = async (interaction: ChatInputCommandInteraction) => {
  const guildId = interaction.guildId!;
  
  // Check if there are any active polls for this server
  if (!activePolls.has(guildId) || activePolls.get(guildId)!.size === 0) {
    return interaction.reply({ content: 'There are no active polls in this server.', ephemeral: true });
  }
  
  const serverPolls = activePolls.get(guildId)!;
  const pollList = Array.from(serverPolls.entries()).map(([id, { message, eligibleVoters, votes }]) => {
    const embed = message.embeds[0];
    const votedCount = votes.size;
    const totalVoters = eligibleVoters.size;
    const remainingVoters = Math.max(0, totalVoters - votedCount);
    
    return `**ID**: ${id} - **Question**: ${embed.title} - **Votes**: ${votedCount}/${totalVoters || '?'} - **Remaining**: ${remainingVoters || '?'}`;
  }).join('\n');
  
  return interaction.reply({ 
    content: `**Active Polls:**\n${pollList}\n\nUse \`/endpoll poll_id:<ID>\` to end a specific poll.`, 
    ephemeral: true 
  });
};