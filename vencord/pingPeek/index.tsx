/*
 * PingPeek
 * Copyright (c) 2026 4uthen7
 * SPDX-License-Identifier: MIT
 */

import { definePluginSettings } from "@api/Settings";
import { copyToClipboard } from "@utils/clipboard";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { findByProps } from "@webpack";
import {
    ChannelStore,
    ContextMenuApi,
    EmojiStore,
    GuildMemberStore,
    GuildRoleStore,
    GuildStore,
    Menu,
    MessageActions,
    NavigationRouter,
    RelationshipStore,
    RestAPI,
    SelectedChannelStore,
    showToast,
    UserGuildSettingsStore,
    UserStore
} from "@webpack/common";

import style from "./styles.css?managed";
import { contrastText, defaultAvatar, emojiNode, h, parseEmoji, ReactionEmoji } from "./utils";

const logger = new Logger("PingPeek", "#00b0f4");

interface Entry {
    message: any;
    channelId: string;
    guildId: string | null;
    channel: any;
    t: number;
    likely: boolean;
    used?: boolean;
}

interface LastPing {
    guildId: string | null;
    channelId: string;
    t: number;
}

const settings = definePluginSettings({
    mode: {
        type: OptionType.SELECT,
        description: "プレビューを出すタイミング（Discordの通知音をOFFにしている場合は「通知設定から判定」）",
        options: [
            { label: "通知音が鳴った時だけ", value: "sound", default: true },
            { label: "通知設定から判定", value: "logic" }
        ]
    },
    duration: {
        type: OptionType.NUMBER,
        description: "自動で消えるまでの秒数（0 で消えない）",
        default: 6
    },
    maxStack: {
        type: OptionType.SLIDER,
        description: "同時に表示する数",
        markers: [1, 2, 3, 4, 5, 6],
        stickToMarkers: true,
        default: 3
    },
    topOffset: {
        type: OptionType.NUMBER,
        description: "ウィンドウ上端からの位置（px）",
        default: 36,
        onChange: () => applyContainerVars()
    },
    width: {
        type: OptionType.NUMBER,
        description: "プレビューの幅（px）",
        default: 420,
        onChange: () => applyContainerVars()
    },
    showWhenViewing: {
        type: OptionType.BOOLEAN,
        description: "今見ているチャンネルの通知も表示する",
        default: false
    },
    pauseWhenUnfocused: {
        type: OptionType.BOOLEAN,
        description: "Discordが非アクティブな間はタイマーを止める",
        default: true,
        onChange: () => onWinFocus()
    },
    showImages: {
        type: OptionType.BOOLEAN,
        description: "画像をプレビューする",
        default: true
    },
    quickReactions: {
        type: OptionType.STRING,
        description: "クイックリアクション（スペース区切り、カスタム絵文字は <:name:id>）",
        default: "👍 ❤️ 😂 😮 😢 🙏"
    },
    matchWindow: {
        type: OptionType.NUMBER,
        description: "通知音とメッセージを紐付ける猶予（ms）",
        default: 1500
    },
    markColor: {
        type: OptionType.COMPONENT,
        default: "#00b0f4",
        onChange: () => updateMarkCss(),
        component: ({ setValue }) => (
            <div style={{ display: "flex", alignItems: "center", gap: 12, color: "var(--text-default, var(--text-normal))" }}>
                <input
                    type="color"
                    defaultValue={settings.store.markColor}
                    onChange={e => setValue(e.currentTarget.value)}
                    style={{ width: 48, height: 30, border: 0, background: "none", cursor: "pointer" }}
                />
                <span>最後に通知したサーバーのマーク色</span>
            </div>
        )
    },
    markRing: {
        type: OptionType.BOOLEAN,
        description: "サーバーアイコンの周りを光らせる",
        default: true,
        onChange: () => updateMarkCss()
    },
    markPulse: {
        type: OptionType.BOOLEAN,
        description: "光を脈動させる",
        default: true,
        onChange: () => updateMarkCss()
    },
    markBadge: {
        type: OptionType.BOOLEAN,
        description: "右下の通知数バッジの色を変える（数字はそのまま）",
        default: true,
        onChange: () => updateMarkCss()
    },
    markPill: {
        type: OptionType.BOOLEAN,
        description: "左の未読ピルの色を変える",
        default: true,
        onChange: () => updateMarkCss()
    },
    markChannel: {
        type: OptionType.BOOLEAN,
        description: "チャンネル一覧の該当チャンネルも色付けする",
        default: true,
        onChange: () => updateMarkCss()
    },
    clearOnVisit: {
        type: OptionType.BOOLEAN,
        description: "そのサーバーを開いたらマークを消す",
        default: false
    },
    lastPing: {
        type: OptionType.CUSTOM,
        default: null as LastPing | null
    }
});

let container: HTMLDivElement | null = null;
let markStyle: HTMLStyleElement | null = null;
let pendingMsgs: Entry[] = [];
let pendingSounds: number[] = [];
let seen = new Set<string>();
let matchTimer: ReturnType<typeof setTimeout> | undefined;
let moduleSoundSeen = false;
let lastGenericSound = 0;
const unpatches: (() => void)[] = [];

// --- sound detection ---

function onSound(name: unknown, src: "module" | "media" | "webaudio") {
    if (settings.store.mode !== "sound") return;
    const now = Date.now();
    if (src === "module") {
        if (!/message|mention|reply/i.test(String(name ?? ""))) return;
        moduleSoundSeen = true;
    } else {
        // playSound が使われているなら、そちら経由の音だけを信用する
        if (moduleSoundSeen) return;
        if (now - lastGenericSound < 150) return;
        lastGenericSound = now;
    }
    pendingSounds.push(now);
    scheduleMatch();
}

function patchMethod(obj: any, key: string, before: (self: any, args: any[]) => void) {
    const orig = obj?.[key];
    if (typeof orig !== "function") return false;
    const wrapped = function (this: any, ...args: any[]) {
        try { before(this, args); } catch (e) { logger.error(e); }
        return orig.apply(this, args);
    };
    try {
        obj[key] = wrapped;
    } catch {
        return false;
    }
    if (obj[key] !== wrapped) return false;
    unpatches.push(() => { obj[key] = orig; });
    return true;
}

function hookSounds() {
    let soundModule: any = null;
    try { soundModule = findByProps("playSound"); } catch { }
    if (soundModule) patchMethod(soundModule, "playSound", (_, args) => onSound(args[0], "module"));

    patchMethod(HTMLMediaElement.prototype, "play", el => {
        if (el instanceof HTMLAudioElement && !el.muted && el.volume > 0) onSound(null, "media");
    });
    if (window.AudioBufferSourceNode) {
        patchMethod(AudioBufferSourceNode.prototype, "start", () => onSound(null, "webaudio"));
    }
}

// --- matching ---

function scheduleMatch() {
    clearTimeout(matchTimer);
    matchTimer = setTimeout(match, 60);
}

function match() {
    const now = Date.now();
    const win = settings.store.matchWindow;
    pendingMsgs = pendingMsgs.filter(m => !m.used && now - m.t < win * 2);
    const keep: number[] = [];
    for (const s of pendingSounds) {
        const cands = pendingMsgs.filter(m => !m.used && m.t - s <= 300 && s - m.t <= win);
        if (!cands.length) {
            if (now - s < 300) keep.push(s);
            continue;
        }
        cands.sort((a, b) => (Number(b.likely) - Number(a.likely)) || (b.t - a.t));
        cands[0].used = true;
        notify(cands[0]);
    }
    pendingSounds = keep;
    if (keep.length) matchTimer = setTimeout(match, 120);
}

function isViewing(channelId: string) {
    return SelectedChannelStore.getChannelId() === channelId && document.hasFocus();
}

function isMentioned(msg: any, guildId: string, me: string) {
    if ((msg.mentions ?? []).some((u: any) => (u?.id ?? u) === me)) return true;
    if (msg.mention_everyone && !UserGuildSettingsStore.isSuppressEveryoneEnabled(guildId)) return true;
    const roles: string[] = msg.mention_roles ?? [];
    if (roles.length) {
        const member = GuildMemberStore.getMember(guildId, me);
        if (member?.roles?.some(r => roles.includes(r))) return true;
    }
    return false;
}

function wouldNotify(msg: any, channel: any, guildId: string | null, me: string) {
    if (!channel) return false;
    if (RelationshipStore.isBlocked(msg.author.id)) return false;
    if (!guildId) return !UserGuildSettingsStore.isChannelMuted(null, channel.id);
    if (UserGuildSettingsStore.isMuted(guildId)) return false;
    if (UserGuildSettingsStore.isChannelMuted(guildId, channel.id)) return false;
    if (channel.parent_id && UserGuildSettingsStore.isChannelMuted(guildId, channel.parent_id)) return false;

    const unset = (v: unknown) => v == null || v === 3;
    let level: any = UserGuildSettingsStore.getChannelMessageNotifications(guildId, channel.id);
    if (unset(level) && channel.parent_id) level = UserGuildSettingsStore.getChannelMessageNotifications(guildId, channel.parent_id);
    if (unset(level)) level = UserGuildSettingsStore.getMessageNotifications(guildId);
    if (level === 0) return true;
    if (level === 2) return false;
    return isMentioned(msg, guildId, me);
}

function onMessageCreate({ message, optimistic, guildId: actGuildId, channelId: actChannelId }: any) {
    if (optimistic || !message?.author || message.state === "SENDING") return;
    const me = UserStore.getCurrentUser()?.id;
    if (message.author.id === me || seen.has(message.id)) return;

    const channelId = message.channel_id || actChannelId;
    const channel = ChannelStore.getChannel(channelId) ?? null;
    const guildId = message.guild_id || actGuildId || channel?.guild_id || null;
    const entry: Entry = { message, channelId, guildId, channel, t: Date.now(), likely: false };
    try { entry.likely = wouldNotify(message, channel, guildId, me); } catch (e) { logger.error(e); }

    if (settings.store.mode === "logic") {
        if (entry.likely && !isViewing(channelId)) notify(entry);
        return;
    }
    pendingMsgs.push(entry);
    if (pendingMsgs.length > 50) pendingMsgs.splice(0, pendingMsgs.length - 50);
    scheduleMatch();
}

function onChannelSelect({ guildId, channelId }: any) {
    const lp = settings.store.lastPing;
    if (!lp || !settings.store.clearOnVisit) return;
    if ((lp.guildId && guildId === lp.guildId) || (!lp.guildId && channelId === lp.channelId)) clearLastPing();
}

function notify(entry: Entry) {
    seen.add(entry.message.id);
    if (seen.size > 500) seen = new Set([...seen].slice(-200));
    setLastPing(entry);
    if (!settings.store.showWhenViewing && isViewing(entry.channelId)) return;
    showCard(entry);
}

// --- server mark ---

function setLastPing(entry: Entry) {
    settings.store.lastPing = { guildId: entry.guildId, channelId: entry.channelId, t: Date.now() };
    updateMarkCss();
}

function clearLastPing() {
    settings.store.lastPing = null;
    updateMarkCss();
}

function updateMarkCss() {
    if (!markStyle) return;
    const lp = settings.store.lastPing;
    if (!lp) {
        markStyle.textContent = "";
        return;
    }
    const s = settings.store;
    const c = s.markColor;
    const fg = contrastText(c);
    const navIds = [lp.guildId ?? lp.channelId];
    const css: string[] = [];

    for (const id of navIds) {
        const li = `div[class*="listItem"]:has([data-list-item-id="guildsnav___${id}"])`;
        if (s.markRing) {
            css.push(`${li} [class*="blobContainer"] {
                filter: drop-shadow(0 0 2px ${c}) drop-shadow(0 0 2px ${c});
                ${s.markPulse ? "animation: pp-mark-pulse 1.8s ease-in-out infinite;" : ""}
            }`);
        }
        if (s.markBadge) {
            css.push(`${li} [class*="numberBadge"],
                ${li} [class*="lowerBadge"] > [class*="badge"],
                ${li} [class*="mentionsBadge"] {
                background-color: ${c} !important;
                color: ${fg} !important;
            }`);
        }
        if (s.markPill) css.push(`${li} [class*="pill"] span { background-color: ${c} !important; }`);
    }
    if (s.markChannel) {
        css.push(`[data-list-item-id="channels___${lp.channelId}"],
            a[href="/channels/@me/${lp.channelId}"] {
            box-shadow: inset 3px 0 0 ${c};
            background-color: color-mix(in srgb, ${c} 16%, transparent) !important;
            border-radius: 4px;
        }`);
    }
    css.push(`@keyframes pp-mark-pulse {
        0%, 100% { filter: drop-shadow(0 0 1px ${c}) drop-shadow(0 0 2px ${c}); }
        50% { filter: drop-shadow(0 0 4px ${c}) drop-shadow(0 0 6px ${c}); }
    }`);
    markStyle.textContent = css.join("\n");
}

// --- card ---

function applyContainerVars() {
    if (!container) return;
    container.style.setProperty("--pp-top", settings.store.topOffset + "px");
    container.style.setProperty("--pp-width", settings.store.width + "px");
}

function onWinFocus() {
    container?.classList.toggle("pp-unfocused", settings.store.pauseWhenUnfocused && !document.hasFocus());
}

function quickList(): ReactionEmoji[] {
    return settings.store.quickReactions.split(/\s+/).filter(Boolean).map(parseEmoji).slice(0, 8);
}

function displayName(author: any, guildId: string | null): string {
    if (!author) return "不明なユーザー";
    const nick = guildId ? GuildMemberStore.getNick(guildId, author.id) : null;
    return nick || author.global_name || author.globalName || author.username || "不明なユーザー";
}

function avatarUrl(author: any, guildId: string | null) {
    try {
        const url = UserStore.getUser(author.id)?.getAvatarURL(guildId ?? undefined, 80);
        if (url) return url;
    } catch { }
    if (author.avatar) {
        const ext = author.avatar.startsWith("a_") ? "gif" : "png";
        return `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.${ext}?size=80`;
    }
    return defaultAvatar(author.id, author.discriminator);
}

function sourceIcon(guild: any) {
    if (guild?.icon) {
        return h("img", { class: "pp-gicon", src: `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=32`, alt: "", draggable: "false" });
    }
    if (guild) {
        const ac = guild.acronym || String(guild.name || "?").split(/\s+/).map((w: string) => w[0]).join("").slice(0, 3);
        return h("span", { class: "pp-gicon pp-gicon-text" }, ac);
    }
    return h("span", { class: "pp-gicon pp-gicon-text" }, "DM");
}

function sourceLabel(channel: any, guild: any) {
    if (guild) {
        let ch = channel?.name ? `#${channel.name}` : "";
        if (channel && (channel.type === 11 || channel.type === 12) && channel.parent_id) {
            const parent = ChannelStore.getChannel(channel.parent_id);
            if (parent?.name) ch = `#${parent.name} › ${channel.name}`;
        }
        return ch ? `${guild.name} › ${ch}` : guild.name;
    }
    if (channel?.type === 3) {
        if (channel.name) return channel.name;
        const names = (channel.recipients ?? [])
            .map((id: string) => {
                const u: any = UserStore.getUser(id);
                return u?.globalName || u?.username;
            })
            .filter(Boolean);
        return names.length ? names.join(", ") : "グループDM";
    }
    return "ダイレクトメッセージ";
}

function timeLabel(m: any) {
    const d = m.timestamp ? new Date(m.timestamp) : new Date();
    if (isNaN(d.getTime()) || Date.now() - d.getTime() < 60000) return "今";
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function mentionNode(kind: string, id: string, guildId: string | null) {
    let label: string;
    if (kind === "#") {
        label = "#" + (ChannelStore.getChannel(id)?.name || "不明なチャンネル");
    } else if (kind === "@&") {
        const role = guildId ? GuildRoleStore.getRole(guildId, id) : null;
        label = "@" + (role?.name || "不明なロール");
    } else {
        const u = UserStore.getUser(id);
        label = "@" + (u ? displayName(u, guildId) : "不明なユーザー");
    }
    return h("span", { class: "pp-mention" }, label);
}

function imageOf(m: any): string | null {
    const a = (m.attachments ?? []).find((x: any) =>
        !String(x.filename || "").startsWith("SPOILER_")
        && ((x.content_type || "").startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(x.filename || "")));
    return a ? (a.proxy_url || a.url) : null;
}

function extraLabel(m: any) {
    const stickers = m.sticker_items ?? m.stickers ?? [];
    if (stickers.length) return `［スタンプ: ${stickers[0].name}］`;
    const att = m.attachments ?? [];
    if (att.length) {
        if (settings.store.showImages && imageOf(m)) return "";
        return `［添付ファイル: ${att[0].filename}${att.length > 1 ? ` ほか${att.length - 1}件` : ""}］`;
    }
    const em = (m.embeds ?? [])[0];
    if (em) return em.title || em.rawTitle || em.description || em.rawDescription || "［埋め込み］";
    if (m.poll) return "［投票］";
    return "";
}

function renderContent(m: any, guildId: string | null) {
    const wrap = h("div", { class: "pp-content" });
    const raw = String(m.content || "").replace(/\|\|[\s\S]+?\|\|/g, "［スポイラー］");
    const re = /<(@!?|@&|#)(\d+)>|<(a?):(\w+):(\d+)>/g;
    let last = 0;
    let mt: RegExpExecArray | null;
    while ((mt = re.exec(raw))) {
        if (mt.index > last) wrap.append(raw.slice(last, mt.index));
        if (mt[1]) wrap.append(mentionNode(mt[1], mt[2], guildId));
        else wrap.append(emojiNode({ id: mt[5], name: mt[4], animated: !!mt[3] }));
        last = re.lastIndex;
    }
    if (last < raw.length) wrap.append(raw.slice(last));
    if (!raw.trim()) {
        const extra = extraLabel(m);
        if (extra) wrap.append(h("span", { class: "pp-dim" }, extra));
    }
    return wrap;
}

function showCard(entry: Entry) {
    if (!container) return;
    const { message: m, channel, guildId } = entry;
    const guild = guildId ? GuildStore.getGuild(guildId) : null;
    const s = settings.store;

    const closeBtn = h("button", { class: "pp-close", title: "閉じる", "aria-label": "閉じる" }, "×");
    const head = h("div", { class: "pp-head" },
        sourceIcon(guild),
        h("span", { class: "pp-src" }, sourceLabel(channel, guild)),
        h("span", { class: "pp-time" }, timeLabel(m)),
        closeBtn
    );

    const main = h("div", { class: "pp-main" },
        h("div", { class: "pp-author" }, displayName(m.author, guildId)),
        renderContent(m, guildId)
    );
    const img = s.showImages && imageOf(m);
    if (img) main.append(h("img", { class: "pp-image", src: img, alt: "", draggable: "false" }));

    const body = h("div", { class: "pp-body" },
        h("img", { class: "pp-avatar", src: avatarUrl(m.author, guildId), alt: "", draggable: "false" }),
        main
    );

    const input = h("input", { class: "pp-reply-input", type: "text", placeholder: "返信を入力して Enter（Escで閉じる）" });
    const form = h("form", { class: "pp-reply" }, input);
    const fill = h("div", { class: "pp-progress-fill" });
    const actions = h("div", { class: "pp-actions" });
    const card = h("div", { class: "pp-toast" + (s.duration > 0 ? "" : " pp-sticky"), role: "alert" },
        head, body, actions, form, h("div", { class: "pp-progress" }, fill));

    for (const emoji of quickList()) {
        const b = h("button", { class: "pp-react", title: "リアクション" }, emojiNode(emoji));
        b.addEventListener("click", e => {
            e.stopPropagation();
            react(entry, emoji, b);
        });
        actions.append(b);
    }
    const replyBtn = h("button", { class: "pp-act", title: "返信" }, "返信");
    replyBtn.addEventListener("click", e => {
        e.stopPropagation();
        openReply(card, entry);
    });
    actions.append(h("span", { class: "pp-spacer" }), replyBtn);

    form.addEventListener("submit", e => {
        e.preventDefault();
        sendReply(card, entry, input);
    });
    for (const ev of ["keydown", "keyup", "keypress"] as const) {
        input.addEventListener(ev, e => {
            e.stopPropagation();
            if (ev === "keydown" && e.key === "Escape") {
                form.classList.remove("pp-open");
                card.classList.remove("pp-hold");
            }
        });
    }

    card.style.setProperty("--pp-accent", s.markColor);
    card.style.setProperty("--pp-duration", Math.max(1000, s.duration * 1000) + "ms");

    card.addEventListener("animationend", e => {
        if (e.target !== card) return;
        if (e.animationName === "pp-in") card.classList.add("pp-shown");
        else if (e.animationName === "pp-out") card.remove();
    });
    fill.addEventListener("animationend", () => dismiss(card));
    closeBtn.addEventListener("click", e => {
        e.stopPropagation();
        dismiss(card);
    });
    card.addEventListener("auxclick", e => {
        if (e.button === 1) dismiss(card);
    });
    card.addEventListener("contextmenu", e => openMenu(e, entry, card));
    bindSwipe(card, entry);

    container.prepend(card);
    const live = [...container.querySelectorAll<HTMLElement>(".pp-toast:not(.pp-out)")];
    for (const old of live.slice(Math.max(1, s.maxStack))) dismiss(old);
}

function bindSwipe(card: HTMLElement, entry: Entry) {
    let start: { x: number; y: number; } | null = null;
    let moved = false;

    card.addEventListener("pointerdown", e => {
        if (e.button !== 0 || (e.target as HTMLElement).closest("button, input, .pp-reply")) return;
        start = { x: e.clientX, y: e.clientY };
        moved = false;
        card.setPointerCapture?.(e.pointerId);
        card.classList.add("pp-dragging");
    });
    card.addEventListener("pointermove", e => {
        if (!start) return;
        const dy = e.clientY - start.y;
        if (Math.abs(dy) > 6 || Math.abs(e.clientX - start.x) > 6) moved = true;
        card.style.setProperty("--pp-drag", (dy < 0 ? dy : dy / 4) + "px");
        card.style.opacity = dy < 0 ? String(Math.max(0, 1 + dy / 120)) : "";
    });
    const end = (e: PointerEvent, cancelled: boolean) => {
        if (!start) return;
        const dy = e.clientY - start.y;
        start = null;
        card.classList.remove("pp-dragging");
        if (!cancelled && dy < -40) {
            dismiss(card);
            return;
        }
        card.style.setProperty("--pp-drag", "0px");
        card.style.opacity = "";
        if (!cancelled && !moved) {
            jump(entry);
            dismiss(card);
        }
    };
    card.addEventListener("pointerup", e => end(e, false));
    card.addEventListener("pointercancel", e => end(e, true));
}

function dismiss(card: HTMLElement) {
    if (card.classList.contains("pp-out")) return;
    card.style.maxHeight = card.offsetHeight + "px";
    card.classList.add("pp-out");
    setTimeout(() => card.remove(), 600);
}

function dismissAll() {
    container?.querySelectorAll<HTMLElement>(".pp-toast").forEach(dismiss);
}

// --- actions ---

function jump(entry: Entry) {
    NavigationRouter.transitionTo(`/channels/${entry.guildId ?? "@me"}/${entry.channelId}/${entry.message.id}`);
}

function messageLink(entry: Entry) {
    return `https://discord.com/channels/${entry.guildId ?? "@me"}/${entry.channelId}/${entry.message.id}`;
}

async function react(entry: Entry, emoji: ReactionEmoji, btn?: HTMLElement) {
    const key = emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
    try {
        await RestAPI.put({
            url: `/channels/${entry.channelId}/messages/${entry.message.id}/reactions/${encodeURIComponent(key)}/@me`
        });
        btn?.classList.add("pp-reacted");
    } catch (e) {
        logger.error(e);
        showToast({ text: "リアクションに失敗しました", variant: "critical" });
    }
}

function openReply(card: HTMLElement, entry: Entry) {
    const form = card.querySelector(".pp-reply")!;
    const input = form.querySelector("input")!;
    form.classList.add("pp-open");
    card.classList.add("pp-hold");
    input.placeholder = `${displayName(entry.message.author, entry.guildId)} に返信（Enterで送信 / Escで閉じる）`;
    setTimeout(() => input.focus(), 0);
}

async function sendReply(card: HTMLElement, entry: Entry, input: HTMLInputElement) {
    const content = input.value.trim();
    if (!content) return;
    input.disabled = true;
    try {
        await MessageActions.sendMessage(
            entry.channelId,
            { content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] },
            undefined,
            { messageReference: { guild_id: entry.guildId ?? undefined, channel_id: entry.channelId, message_id: entry.message.id } }
        );
        showToast({ text: "返信しました", variant: "success" });
        dismiss(card);
    } catch (e) {
        logger.error(e);
        input.disabled = false;
        showToast({ text: "返信に失敗しました", variant: "critical" });
    }
}

function menuEmojis(guildId: string | null) {
    const out: { emoji: ReactionEmoji; label: string; }[] = [];
    const seenKeys = new Set<string>();
    const push = (emoji: ReactionEmoji, label: string) => {
        const k = emoji.id || emoji.name;
        if (!k || seenKeys.has(k)) return;
        seenKeys.add(k);
        out.push({ emoji, label });
    };
    try {
        const ctx: any = EmojiStore.getDisambiguatedEmojiContext(guildId);
        const fr = ctx?.getFrequentlyUsedReactionEmojisWithoutFetchingLatest?.()
            ?? ctx?.getFrequentlyUsedEmojisWithoutFetchingLatest?.() ?? [];
        const arr: any[] = Array.isArray(fr) ? fr : (fr?.toArray?.() ?? []);
        for (const e of arr.slice(0, 10)) {
            if (e?.id) push({ id: e.id, name: e.name, animated: !!e.animated }, `:${e.name}:`);
            else if (e?.surrogates) push({ id: null, name: e.surrogates, animated: false }, `${e.surrogates}  :${e.name}:`);
        }
    } catch { }
    for (const e of quickList()) push(e, e.id ? `:${e.name}:` : e.name);
    return out.slice(0, 16);
}

function openMenu(e: MouseEvent, entry: Entry, card: HTMLElement) {
    e.preventDefault();
    e.stopPropagation();
    card.classList.add("pp-hold");
    const release = () => {
        if (!card.querySelector(".pp-reply.pp-open")) card.classList.remove("pp-hold");
    };
    setTimeout(release, 20000);

    ContextMenuApi.openContextMenu(e as any, () => (
        <Menu.Menu
            navId="ping-peek"
            onClose={() => {
                ContextMenuApi.closeContextMenu();
                release();
            }}
        >
            <Menu.MenuItem id="pp-reactions" label="リアクションを付ける">
                {menuEmojis(entry.guildId).map((em, i) => (
                    <Menu.MenuItem key={i} id={`pp-react-${i}`} label={em.label} action={() => react(entry, em.emoji)} />
                ))}
            </Menu.MenuItem>
            <Menu.MenuItem id="pp-reply" label="返信" action={() => openReply(card, entry)} />
            <Menu.MenuItem id="pp-jump" label="メッセージへ移動" action={() => { jump(entry); dismiss(card); }} />
            <Menu.MenuSeparator />
            <Menu.MenuItem id="pp-copy-text" label="テキストをコピー" action={() => copyToClipboard(entry.message.content ?? "")} />
            <Menu.MenuItem id="pp-copy-link" label="メッセージリンクをコピー" action={() => copyToClipboard(messageLink(entry))} />
            <Menu.MenuItem id="pp-copy-id" label="メッセージIDをコピー" action={() => copyToClipboard(entry.message.id)} />
            <Menu.MenuSeparator />
            <Menu.MenuItem id="pp-clear-mark" label="サーバーのマークを消す" disabled={!settings.store.lastPing} action={clearLastPing} />
            <Menu.MenuItem id="pp-close" label="閉じる" action={() => dismiss(card)} />
            <Menu.MenuItem id="pp-close-all" label="すべて閉じる" color="danger" action={dismissAll} />
        </Menu.Menu>
    ));
}

export default definePlugin({
    name: "PingPeek",
    description: "通知音が鳴ったメッセージを上部中央にスマホ風プレビューで表示し、最後に通知したサーバーを指定色でマークします",
    authors: [{ name: "4uthen7", id: 0n }],
    settings,
    managedStyle: style,

    flux: {
        MESSAGE_CREATE(e) {
            try { onMessageCreate(e); } catch (err) { logger.error(err); }
        },
        CHANNEL_SELECT(e) {
            try { onChannelSelect(e); } catch (err) { logger.error(err); }
        }
    },

    start() {
        pendingMsgs = [];
        pendingSounds = [];
        seen = new Set();
        moduleSoundSeen = false;

        container = h("div", { class: "pp-container" });
        document.body.appendChild(container);
        applyContainerVars();
        onWinFocus();
        window.addEventListener("focus", onWinFocus);
        window.addEventListener("blur", onWinFocus);

        markStyle = h("style", { id: "pingpeek-mark" });
        document.head.appendChild(markStyle);
        updateMarkCss();

        hookSounds();
    },

    stop() {
        unpatches.splice(0).forEach(fn => fn());
        clearTimeout(matchTimer);
        window.removeEventListener("focus", onWinFocus);
        window.removeEventListener("blur", onWinFocus);
        container?.remove();
        markStyle?.remove();
        container = null;
        markStyle = null;
    }
});
