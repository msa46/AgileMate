import { REST, Routes } from 'discord.js';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

// Get current directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
const token = process.env.TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID; // Optional: for guild-specific command deployment

if (!token || !clientId) {
  console.error('Missing required environment variables (TOKEN, CLIENT_ID)');
  process.exit(1);
}

const commands = [];
const commandsPath = path.join(__dirname, 'commands/utility');

// Read all command files
const commandFiles = fs.readdirSync(commandsPath).filter(file => 
  file.endsWith('.ts') || file.endsWith('.js')
);

// Load commands
(async () => {
  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = await import(`file://${filePath}`);
    
    // Add main command
    if ('data' in command && 'execute' in command) {
      commands.push(command.data.toJSON());
      console.log(`Added command: ${command.data.name}`);
    }
    
    // Add subcommands if they exist
    if ('endData' in command && 'endExecute' in command) {
      commands.push(command.endData.toJSON());
      console.log(`Added subcommand: ${command.endData.name}`);
    }
    
    if ('listData' in command && 'listExecute' in command) {
      commands.push(command.listData.toJSON());
      console.log(`Added subcommand: ${command.listData.name}`);
    }
  }
  
  // Create REST instance
  const rest = new REST({ version: '10' }).setToken(token);
  
  try {
    console.log(`Started refreshing ${commands.length} application (/) commands.`);
    
    let data;
    if (guildId) {
      // Guild-specific registration (faster for development)
      data = await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: commands },
      );
      console.log(`Successfully registered ${commands.length} commands for guild ${guildId}`);
    } else {
      // Global registration (can take up to an hour to propagate)
      data = await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands },
      );
      console.log(`Successfully registered ${commands.length} global commands`);
    }
  } catch (error) {
    console.error('Error registering commands:', error);
  }
})();