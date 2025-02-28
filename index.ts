import { Client, Events, GatewayIntentBits, Collection } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Define the proper type extension for Client
declare module 'discord.js' {
  interface Client {
    commands: Collection<string, any>;
  }
}

// Get the current file directory using ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ] 
});
const token = process.env.TOKEN;

// Initialize commands collection
client.commands = new Collection();

// Function to load commands
const loadCommands = async (client: Client) => {
  try {
    const commandsPath = path.join(__dirname, 'commands');
    
    // Check if directory exists
    if (!fs.existsSync(commandsPath)) {
      console.error(`Commands directory not found at ${commandsPath}`);
      return;
    }
    
    const commandFiles = fs.readdirSync(commandsPath).filter(file => 
      file.endsWith('.ts') || file.endsWith('.js')
    );
    
    console.log(`Found ${commandFiles.length} command files`);
    
    for (const file of commandFiles) {
      const filePath = path.join(commandsPath, file);
      
      // Use dynamic import for ESM compatibility with Bun
      const command = await import(`file://${filePath}`);
      
      // Check if command has required data and execute properties
      if ('data' in command && 'execute' in command) {
        client.commands.set(command.data.name, command);
        console.log(`Loaded command: ${command.data.name}`);
        
        // Register subcommands if they exist
        if ('endData' in command && 'endExecute' in command) {
          client.commands.set(command.endData.name, { 
            data: command.endData, 
            execute: command.endExecute 
          });
          console.log(`Loaded subcommand: ${command.endData.name}`);
        }
        
        if ('listData' in command && 'listExecute' in command) {
          client.commands.set(command.listData.name, { 
            data: command.listData, 
            execute: command.listExecute 
          });
          console.log(`Loaded subcommand: ${command.listData.name}`);
        }
      } else {
        console.warn(`The command at ${filePath} is missing a required "data" or "execute" property`);
      }
    }
  } catch (error) {
    console.error('Error loading commands:', error);
  }
};

// Events
client.once(Events.ClientReady, readyClient => {
  console.log(`Ready! Logged in as ${readyClient.user.tag}`);
  
  // Initialize standup jobs if the command is loaded
  const standupCommand = client.commands.get('standup');
  if (standupCommand && 'onReady' in standupCommand) {
    standupCommand.onReady(client);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  
  const command = client.commands.get(interaction.commandName);
  
  if (!command) {
    console.error(`No command matching ${interaction.commandName} was found.`);
    return;
  }
  
  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: 'There was an error executing this command!', ephemeral: true });
    } else {
      await interaction.reply({ content: 'There was an error executing this command!', ephemeral: true });
    }
  }
});

// Main function to start the bot
const main = async () => {
  // Load commands before logging in
  await loadCommands(client);
  
  // Login to Discord
  client.login(token);
  console.log('Attempting to log in...');
};

// Start the bot
main().catch(error => {
  console.error('Failed to start the bot:', error);
});