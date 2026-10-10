import {
   ActionRowBuilder,
   ApplicationIntegrationType,
   ButtonBuilder,
   ButtonStyle,
   Client,
   GatewayIntentBits,
   InteractionContextType,
   REST,
   Routes,
   SlashCommandBuilder,
   type APIEmbed,
   type ButtonInteraction,
   type ChatInputCommandInteraction,
} from "discord.js"
import { accumulateFill, formatSnapshot, formatTrackedList, walletColor, walletLabel } from "../alerts/format"
import type { FillAlert } from "../pipeline/handleFill"
import type { ChainSocket } from "../chain/ws"
import type { Config } from "../config"
import type { Db } from "../db"
import { checkHolders } from "../pipeline/checkHolders"
import { checkWallet } from "../pipeline/checkWallet"
import { refreshWallet } from "../pipeline/refreshWallet"
import { publicName } from "../polymarket/gamma"

type BotDeps = {
   config: Config
   db: Db
   socket: ChainSocket
   runExclusive: <T>(task: () => Promise<T>) => Promise<T>
}

type CommandResult = {
   content?: string
   embeds?: APIEmbed[]
   components?: ReturnType<ActionRowBuilder<ButtonBuilder>["toJSON"]>[]
}

const commands = [
   slash("track_wallet", "Track a Polymarket wallet")
      .addStringOption(option => option.setName("address").setDescription("Wallet address").setRequired(true))
      .addStringOption(option => option.setName("nickname").setDescription("Name shown on alerts").setRequired(false)),
   slash("nickname", "Set or change a tracked wallet's nickname")
      .addStringOption(option => option.setName("address").setDescription("Wallet address").setRequired(true))
      .addStringOption(option => option.setName("nickname").setDescription("Name shown on alerts").setRequired(true)),
   slash("untrack_wallet", "Stop tracking a wallet")
      .addStringOption(option => option.setName("address").setDescription("Wallet address").setRequired(true)),
   slash("list", "List wallets you are tracking"),
   slash("gm", "Say good morning"),
   slash("check_holders", "Show top holders of a market and their history")
      .addStringOption(option => option.setName("market").setDescription("Condition id, slug, or Polymarket URL").setRequired(true)),
   slash("check_wallet", "Show a wallet's lifetime results")
      .addStringOption(option => option.setName("address").setDescription("Wallet address").setRequired(true)),
].map(command => command.toJSON())

const GREETINGS = [
   "Morning! :sun_with_face:",
   "gm",
   "Good day!",
   "Morning, have a fantastic day!",
   "Hello, sir!",
   "Here's to another great day of tracking wallets!",
   "gm, hope u have a profitable day",
]

function pick(options: string[]): string {
   return options[Math.floor(Math.random() * options.length)]
}

function slash(name: string, description: string) {
   return new SlashCommandBuilder()
      .setName(name)
      .setDescription(description)
      .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
      .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
}

export function startBot(deps: BotDeps): Promise<void> {
   const { config } = deps
   const rest = new REST().setToken(config.discordToken)
   const client = new Client({ intents: [GatewayIntentBits.Guilds] })

   client.on("interactionCreate", async (interaction) => {
      if (interaction.isButton()) {
         try {
            await trackFromButton(deps, interaction)
         } catch (err) {
            const message = err instanceof Error ? err.message : "command failed"
            console.error("track button", err)
            if (interaction.deferred || interaction.replied) await interaction.followUp({ content: message.slice(0, 1900), ephemeral: true })
            else await interaction.reply({ content: message.slice(0, 1900), ephemeral: true })
         }
         return
      }
      if (!interaction.isChatInputCommand()) return
      await interaction.deferReply()
      try {
         await sendReply(interaction, await runCommand(deps, interaction))
      } catch (err) {
         const message = err instanceof Error ? err.message : "command failed"
         console.error(interaction.commandName, err)
         await interaction.editReply(message.slice(0, 1900))
      }
   })

   return new Promise((resolve, reject) => {
      client.once("clientReady", () => {
         const guildId = process.env.DISCORD_GUILD_ID
         const clearGuild = guildId
            ? rest.put(Routes.applicationGuildCommands(config.discordClientId, guildId), { body: [] })
            : Promise.resolve()
         clearGuild
            .then(() => rest.put(Routes.applicationCommands(config.discordClientId), { body: commands }))
            .then(() => {
               console.log(`discord ready as ${client.user?.tag}`)
               resolve()
            })
            .catch(reject)
      })
      client.login(config.discordToken).catch(reject)
   })
}

async function runCommand(deps: BotDeps, interaction: ChatInputCommandInteraction): Promise<CommandResult> {
   const { db, socket, runExclusive } = deps
   const name = interaction.commandName
   if (name === "gm") return { content: pick(GREETINGS) }
   if (name === "list") {
      const wallets = db.listForUser(interaction.user.id)
      if (wallets.length === 0) return { content: "You are not tracking any wallets" }
      return { embeds: [formatTrackedList(wallets)] }
   }
   if (name === "track_wallet") {
      const address = parseAddress(interaction.options.getString("address", true))
      if (!address) return { content: "Address must be 0x and 40 hex characters" }
      const nickname = parseNickname(interaction.options.getString("nickname"))
      if (nickname === false) return { content: "Nickname must be 1 to 32 characters" }
      db.track(interaction.user.id, address)
      if (nickname) db.setNickname(interaction.user.id, address, nickname)
      await rememberName(db, address)
      socket.setWallets(db.trackedAddresses())
      const snapshot = await runExclusive(() => refreshWallet(db, address))
      const identity = db.walletIdentity(interaction.user.id, address)
      return { embeds: [formatSnapshot({
         wallet: address,
         nickname: identity?.nickname ?? null,
         polymarketName: identity?.polymarketName ?? null,
         ...snapshot,
      })] }
   }
   if (name === "nickname") {
      const address = parseAddress(interaction.options.getString("address", true))
      if (!address) return { content: "Address must be 0x and 40 hex characters" }
      const nickname = parseNickname(interaction.options.getString("nickname", true))
      if (nickname === false || !nickname) return { content: "Nickname must be 1 to 32 characters" }
      if (!db.setNickname(interaction.user.id, address, nickname)) return { content: "You are not tracking that wallet" }
      return { embeds: [formatSnapshotEmpty(address, nickname, db.getPolymarketName(address))] }
   }
   if (name === "untrack_wallet") {
      const address = parseAddress(interaction.options.getString("address", true))
      if (!address) return { content: "Address must be 0x and 40 hex characters" }
      db.untrack(interaction.user.id, address)
      socket.setWallets(db.trackedAddresses())
      return { content: `Stopped tracking ${address}` }
   }
   if (name === "check_holders") {
      const market = interaction.options.getString("market", true)
      return { embeds: await checkHolders(db, market) }
   }
   if (name === "check_wallet") {
      const address = parseAddress(interaction.options.getString("address", true))
      if (!address) return { content: "Address must be 0x and 40 hex characters" }
      const embed = await checkWallet(address)
      if (!embed) return { content: "No Polymarket history for that wallet" }
      const tracking = db.tracks(interaction.user.id, address)
      return { embeds: [embed], components: [trackButton(address, tracking)] }
   }
   return { content: "Unknown command" }
}

async function trackFromButton(deps: BotDeps, interaction: ButtonInteraction) {
   const address = interaction.customId.startsWith("track_wallet:")
      ? parseAddress(interaction.customId.slice("track_wallet:".length))
      : null
   if (!address) return
   await interaction.deferUpdate()
   const { db, socket, runExclusive } = deps
   if (!db.tracks(interaction.user.id, address)) {
      db.track(interaction.user.id, address)
      await rememberName(db, address)
      socket.setWallets(db.trackedAddresses())
      await runExclusive(() => refreshWallet(db, address))
   }
   await interaction.editReply({ components: [trackButton(address, true)] })
}

function trackButton(address: string, tracking: boolean) {
   return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
         .setCustomId(`track_wallet:${address}`)
         .setLabel(tracking ? "Tracking" : "Track wallet")
         .setStyle(tracking ? ButtonStyle.Secondary : ButtonStyle.Primary)
         .setDisabled(tracking),
   ).toJSON()
}

function formatSnapshotEmpty(address: string, nickname: string, polymarketName: string | null): APIEmbed {
   return {
      title: walletLabel(address, polymarketName, nickname),
      description: address,
      color: walletColor(address),
   }
}

async function rememberName(db: Db, address: string) {
   const name = await publicName(address)
   if (name) db.setPolymarketName(address, name)
}

const ALERT_MS = 15 * 60 * 1000

type SentAlert = {
   channelId: string
   messageId: string
   embed: APIEmbed
   usdc: number
   shares: number
   at: number
}

const alerts = new Map<string, SentAlert>()
const dmChannels = new Map<string, string>()

export async function deliverAlert(token: string, userId: string, alert: FillAlert): Promise<void> {
   const key = `${userId}:${alert.wallet}:${alert.tokenId}`
   const cached = alerts.get(key)
   if (alert.side === "BUY" && cached && Date.now() - cached.at < ALERT_MS) {
      const usdc = cached.usdc + alert.usdc
      const shares = cached.shares + alert.shares
      const embed = accumulateFill(cached.embed, alert.embed, usdc, shares)
      const edited = await editMessage(token, cached.channelId, cached.messageId, embed)
      if (edited) {
         alerts.set(key, { ...cached, embed, usdc, shares, at: Date.now() })
         return
      }
      alerts.delete(key)
   }
   const sent = await sendMessage(token, userId, alert.embed)
   if (!sent || alert.side !== "BUY") return
   alerts.set(key, { ...sent, embed: alert.embed, usdc: alert.usdc, shares: alert.shares, at: Date.now() })
   const cutoff = Date.now() - ALERT_MS
   for (const [id, item] of alerts) {
      if (item.at < cutoff) alerts.delete(id)
   }
}

async function editMessage(token: string, channelId: string, messageId: string, embed: APIEmbed): Promise<boolean> {
   const response = await discordCall(token, "PATCH", `/channels/${channelId}/messages/${messageId}`, { embeds: [embed] })
   if (response.ok) return true
   console.error("dm edit failed", await response.text())
   return false
}

async function sendMessage(token: string, userId: string, embed: APIEmbed): Promise<{ channelId: string, messageId: string } | null> {
   const channelId = await dmChannel(token, userId)
   if (!channelId) return null
   const response = await discordCall(token, "POST", `/channels/${channelId}/messages`, { embeds: [embed] })
   if (!response.ok) {
      console.error("dm send failed", userId, await response.text())
      return null
   }
   const message = await response.json() as { id: string }
   return { channelId, messageId: message.id }
}

async function dmChannel(token: string, userId: string): Promise<string | null> {
   const known = dmChannels.get(userId)
   if (known) return known
   const opened = await discordCall(token, "POST", "/users/@me/channels", { recipient_id: userId })
   if (!opened.ok) {
      console.error("dm open failed", userId, await opened.text())
      return null
   }
   const channel = await opened.json() as { id: string }
   dmChannels.set(userId, channel.id)
   return channel.id
}

async function sendReply(interaction: ChatInputCommandInteraction, result: CommandResult) {
   if (result.content && !result.embeds?.length) {
      await interaction.editReply({ content: result.content.slice(0, 1900) })
      return
   }
   const [first, ...rest] = result.embeds ?? []
   await interaction.editReply({
      embeds: first ? [first] : [],
      components: result.components ?? [],
   })
   for (const embed of rest) await interaction.followUp({ embeds: [embed] })
}

function parseAddress(value: string): string | null {
   const address = value.trim().toLowerCase()
   return /^0x[a-f0-9]{40}$/.test(address) ? address : null
}

function parseNickname(value: string | null): string | null | false {
   if (value === null) return null
   const nickname = value.trim()
   if (nickname.length < 1 || nickname.length > 32) return false
   return nickname
}

async function discordCall(token: string, method: "POST" | "PATCH", path: string, body: unknown): Promise<Response> {
   const response = await discordRequest(token, method, path, body)
   if (response.status !== 429) return response
   const retry = await response.json() as { retry_after?: number }
   await Bun.sleep(Math.min(Math.ceil((retry.retry_after ?? 1) * 1000), 5000))
   return discordRequest(token, method, path, body)
}

function discordRequest(token: string, method: "POST" | "PATCH", path: string, body: unknown): Promise<Response> {
   return fetch("https://discord.com/api/v10" + path, {
      method,
      headers: {
         Authorization: `Bot ${token}`,
         "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
   })
}
