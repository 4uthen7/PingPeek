/**
 * @name PingPeek
 * @author 4uthen7
 * @authorLink https://github.com/4uthen7
 * @source https://github.com/4uthen7/PingPeek
 * @updateUrl https://raw.githubusercontent.com/4uthen7/PingPeek/main/betterdiscord/PingPeek.plugin.js
 * @description 通知音が鳴ったメッセージを、ウィンドウ上部中央からスマホ風のプレビューで表示します。クリックでジャンプ、右クリックでリアクション/返信。最後に通知したサーバーを指定色でマークします。
 * @version 1.0.0
 */

"use strict";

const DEFAULTS = {
    mode: "sound",            // "sound" = 実際に通知音が鳴った時だけ / "logic" = 通知設定から判定
    duration: 6000,           // 自動で消えるまで(ms)。0 = 消えない
    maxStack: 3,              // 同時に表示する最大数
    topOffset: 36,            // ウィンドウ上端からの距離(px)
    width: 420,               // プレビューの幅(px)
    matchWindow: 1500,        // 通知音とメッセージを紐付ける猶予(ms)
    showWhenViewing: false,   // 今見ているチャンネルの通知でも表示する
    pauseWhenUnfocused: true, // Discordが非アクティブな間はタイマーを止める
    showImages: true,
    markColor: "#00b0f4",
    markRing: true,           // サーバーアイコンの周りを光らせる
    markBadge: true,          // 右下の通知数バッジの色を変える
    markPill: true,           // 左の白い未読ピルの色を変える
    markChannel: true,        // チャンネル一覧の該当チャンネルを色付け
    markPulse: true,          // リングを脈動させる
    clearOnVisit: false,      // そのサーバーを開いたらマークを消す
    quickReactions: "👍 ❤️ 😂 😮 😢 🙏",
};

const LOG = (...a) => console.log("%c[PingPeek]", "color:#00b0f4;font-weight:bold", ...a);

module.exports = class PingPeek {
    constructor(meta) {
        this.meta = meta || {};
        this.name = this.meta.name || "PingPeek";
    }

    // --- lifecycle ---

    start() {
        this.settings = Object.assign({}, DEFAULTS, BdApi.Data.load(this.name, "settings") || {});
        this.lastPing = BdApi.Data.load(this.name, "lastPing") || null;
        this.pendingMsgs = [];
        this.pendingSounds = [];
        this.seen = new Set();
        this.moduleSoundSeen = false;

        this.findModules();
        this.injectCSS();
        this.createContainer();
        this.subscribe();
        this.hookSounds();
        this.updateMarkCSS();
    }

    stop() {
        this.unsubscribe();
        BdApi.Patcher.unpatchAll(this.name);
        BdApi.DOM.removeStyle(this.name + "-base");
        BdApi.DOM.removeStyle(this.name + "-mark");
        clearTimeout(this.matchTimer);
        this.container?.remove();
        this.container = null;
    }

    saveSettings() {
        BdApi.Data.save(this.name, "settings", this.settings);
    }

    // --- modules ---

    findModules() {
        const W = BdApi.Webpack;
        const safe = (f) => (...a) => { try { return !!f(...a); } catch { return false; } };
        const find = (filter) => {
            try { return W.getModule(safe(filter)) || W.getModule(safe(filter), { searchExports: true }); }
            catch { return null; }
        };
        const store = (n) => { try { return W.getStore(n); } catch { return null; } };
        const fn = (m, k) => m && typeof m === "object" && typeof m[k] === "function";

        this.Stores = {
            User: store("UserStore"),
            Channel: store("ChannelStore"),
            Guild: store("GuildStore"),
            GuildRole: store("GuildRoleStore"),
            GuildMember: store("GuildMemberStore"),
            UserGuildSettings: store("UserGuildSettingsStore"),
            SelectedChannel: store("SelectedChannelStore"),
            Relationship: store("RelationshipStore"),
            Message: store("MessageStore"),
            Emoji: store("EmojiStore"),
        };

        this.Dispatcher =
            find((m) => fn(m, "dispatch") && fn(m, "subscribe") && fn(m, "unsubscribe") && "_subscriptions" in m) ||
            find((m) => fn(m, "dispatch") && fn(m, "subscribe") && fn(m, "unsubscribe"));

        const router = find((m) => fn(m, "transitionTo") && fn(m, "replaceWith")) || find((m) => fn(m, "transitionTo"));
        this.transitionTo = router ? router.transitionTo.bind(router) : null;
        if (!this.transitionTo) {
            try { this.transitionTo = W.getModule(W.Filters.byStrings("transitionTo -"), { searchExports: true }); } catch {}
        }

        this.MessageActions =
            find((m) => fn(m, "jumpToMessage") && fn(m, "sendMessage")) ||
            find((m) => fn(m, "sendMessage") && fn(m, "editMessage"));
        this.ReactionActions = find((m) => fn(m, "addReaction") && fn(m, "removeReaction")) || find((m) => fn(m, "addReaction"));
        this.SoundModule = find((m) => fn(m, "playSound") && fn(m, "createSound")) || find((m) => fn(m, "playSound"));

        this.moduleStatus = {
            Dispatcher: !!this.Dispatcher,
            "通知音フック": !!this.SoundModule,
            "ジャンプ": !!this.transitionTo || !!this.MessageActions?.jumpToMessage,
            "リアクション": !!this.ReactionActions,
            "返信送信": !!this.MessageActions?.sendMessage,
        };
        LOG("modules", this.moduleStatus);
    }

    // --- events ---

    subscribe() {
        this.handlers = {
            MESSAGE_CREATE: (e) => { try { this.onMessageCreate(e); } catch (err) { LOG(err); } },
            CHANNEL_SELECT: (e) => { try { this.onChannelSelect(e); } catch (err) { LOG(err); } },
        };
        if (!this.Dispatcher) {
            BdApi.UI.showToast("PingPeek: Dispatcher が見つかりません（Discordの更新で壊れた可能性）", { type: "error" });
            return;
        }
        for (const [type, h] of Object.entries(this.handlers)) this.Dispatcher.subscribe(type, h);

        this.onWinFocus = () => this.container?.classList.toggle("pp-unfocused", this.settings.pauseWhenUnfocused && !document.hasFocus());
        window.addEventListener("focus", this.onWinFocus);
        window.addEventListener("blur", this.onWinFocus);
    }

    unsubscribe() {
        if (this.Dispatcher && this.handlers) {
            for (const [type, h] of Object.entries(this.handlers)) this.Dispatcher.unsubscribe(type, h);
        }
        if (this.onWinFocus) {
            window.removeEventListener("focus", this.onWinFocus);
            window.removeEventListener("blur", this.onWinFocus);
        }
    }

    // 通知音の検出。Discordのサウンドモジュールが見つかればそれを、なければ <audio>/WebAudio の再生を拾う
    hookSounds() {
        if (this.SoundModule) {
            try {
                BdApi.Patcher.before(this.name, this.SoundModule, "playSound", (_, args) => this.onSound(args[0], "module"));
            } catch (e) { LOG("playSound patch failed", e); }
        }
        BdApi.Patcher.before(this.name, HTMLMediaElement.prototype, "play", (el) => {
            if (el instanceof HTMLAudioElement && !el.muted && el.volume > 0) this.onSound(null, "media");
        });
        if (window.AudioBufferSourceNode) {
            BdApi.Patcher.before(this.name, AudioBufferSourceNode.prototype, "start", () => this.onSound(null, "webaudio"));
        }
    }

    onSound(name, src) {
        if (this.settings.mode !== "sound") return;
        const now = Date.now();
        if (src === "module") {
            if (!/message|mention|reply/i.test(String(name ?? ""))) return;
            this.moduleSoundSeen = true;
            this.lastModuleSound = now;
        } else {
            // サウンドモジュール経由で一度でも鳴ったら汎用フックは使わない（二重検出防止）
            if (this.moduleSoundSeen) return;
            if (now - (this.lastGenericSound || 0) < 150) return;
            this.lastGenericSound = now;
        }
        this.pendingSounds.push(now);
        this.scheduleMatch();
    }

    onMessageCreate({ message, optimistic, guildId: actGuildId, channelId: actChannelId }) {
        if (optimistic || !message?.author || message.state === "SENDING") return;
        const me = this.Stores.User?.getCurrentUser?.()?.id;
        if (message.author.id === me || this.seen.has(message.id)) return;

        const channelId = message.channel_id || actChannelId;
        const channel = this.Stores.Channel?.getChannel?.(channelId) || null;
        const guildId = message.guild_id || actGuildId || channel?.guild_id || null;
        const entry = { message, channelId, guildId, channel, t: Date.now(), likely: false };
        try { entry.likely = this.wouldNotify(message, channel, guildId, me); } catch (e) { LOG(e); }

        if (this.settings.mode === "logic") {
            if (entry.likely && !this.isViewing(channelId)) this.notify(entry);
            return;
        }
        this.pendingMsgs.push(entry);
        if (this.pendingMsgs.length > 50) this.pendingMsgs.splice(0, this.pendingMsgs.length - 50);
        this.scheduleMatch();
    }

    onChannelSelect({ guildId, channelId }) {
        const lp = this.lastPing;
        if (!lp || !this.settings.clearOnVisit) return;
        if ((lp.guildId && guildId === lp.guildId) || (!lp.guildId && channelId === lp.channelId)) this.clearLastPing();
    }

    // 通知音とメッセージを時間で突き合わせる。メッセージは音の少し前に届くのが普通
    scheduleMatch() {
        clearTimeout(this.matchTimer);
        this.matchTimer = setTimeout(() => this.match(), 60);
    }

    match() {
        const now = Date.now();
        const win = this.settings.matchWindow;
        this.pendingMsgs = this.pendingMsgs.filter((m) => !m.used && now - m.t < win * 2);
        const keep = [];
        for (const s of this.pendingSounds) {
            const cands = this.pendingMsgs.filter((m) => !m.used && m.t - s <= 300 && s - m.t <= win);
            if (!cands.length) {
                if (now - s < 300) keep.push(s);
                continue;
            }
            cands.sort((a, b) => (b.likely - a.likely) || (b.t - a.t));
            cands[0].used = true;
            this.notify(cands[0]);
        }
        this.pendingSounds = keep;
        if (keep.length) this.matchTimer = setTimeout(() => this.match(), 120);
    }

    // --- notify logic ---

    isViewing(channelId) {
        return this.Stores.SelectedChannel?.getChannelId?.() === channelId && document.hasFocus();
    }

    // Discord の通知設定から「通知されるはずか」を推定（"logic" モード＆候補の優先度付けに使用）
    wouldNotify(msg, channel, guildId, me) {
        if (!channel) return false;
        const UGS = this.Stores.UserGuildSettings;
        if (this.Stores.Relationship?.isBlocked?.(msg.author.id)) return false;
        if (!guildId) return !UGS?.isChannelMuted?.(null, channel.id);
        if (UGS?.isMuted?.(guildId)) return false;
        if (UGS?.isChannelMuted?.(guildId, channel.id)) return false;
        if (channel.parent_id && UGS?.isChannelMuted?.(guildId, channel.parent_id)) return false;

        const unset = (v) => v == null || v === 3;
        let level = UGS?.getChannelMessageNotifications?.(guildId, channel.id);
        if (unset(level) && channel.parent_id) level = UGS?.getChannelMessageNotifications?.(guildId, channel.parent_id);
        if (unset(level)) level = UGS?.getMessageNotifications?.(guildId);
        if (level === 0) return true;
        if (level === 2) return false;
        return this.isMentioned(msg, guildId, me);
    }

    isMentioned(msg, guildId, me) {
        const mentions = msg.mentions || [];
        if (mentions.some((u) => (u?.id ?? u) === me)) return true;
        if (msg.mention_everyone ?? msg.mentionEveryone) {
            if (!this.Stores.UserGuildSettings?.isSuppressEveryoneEnabled?.(guildId)) return true;
        }
        const roles = msg.mention_roles || msg.mentionRoles || [];
        if (roles.length) {
            const member = this.Stores.GuildMember?.getMember?.(guildId, me);
            if (member?.roles?.some((r) => roles.includes(r))) return true;
        }
        return false;
    }

    notify(entry) {
        this.seen.add(entry.message.id);
        if (this.seen.size > 500) this.seen = new Set([...this.seen].slice(-200));
        this.setLastPing(entry);
        if (!this.settings.showWhenViewing && this.isViewing(entry.channelId)) return;
        this.showToast(entry);
    }

    // --- server mark ---

    setLastPing(entry) {
        this.lastPing = { guildId: entry.guildId || null, channelId: entry.channelId, t: Date.now() };
        BdApi.Data.save(this.name, "lastPing", this.lastPing);
        this.updateMarkCSS();
    }

    clearLastPing() {
        this.lastPing = null;
        BdApi.Data.save(this.name, "lastPing", null);
        this.updateMarkCSS();
    }

    updateMarkCSS() {
        const id = this.name + "-mark";
        const lp = this.lastPing;
        if (!lp) { BdApi.DOM.removeStyle(id); return; }
        const s = this.settings;
        const c = s.markColor;
        const fg = contrastText(c);
        const navIds = [lp.guildId, lp.guildId ? null : lp.channelId].filter(Boolean);
        const css = [];

        for (const nid of navIds) {
            const li = `div[class*="listItem"]:has([data-list-item-id="guildsnav___${nid}"])`;
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
            if (s.markPill) {
                css.push(`${li} [class*="pill"] span { background-color: ${c} !important; }`);
            }
        }
        if (s.markChannel && lp.channelId) {
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
        BdApi.DOM.addStyle(id, css.join("\n"));
    }

    // --- toast UI ---

    createContainer() {
        this.container = h("div", { class: "pp-container" });
        this.applyContainerVars();
        document.body.appendChild(this.container);
        this.onWinFocus?.();
    }

    applyContainerVars() {
        if (!this.container) return;
        this.container.style.setProperty("--pp-top", this.settings.topOffset + "px");
        this.container.style.setProperty("--pp-width", this.settings.width + "px");
    }

    showToast(entry) {
        if (!this.container) return;
        const { message: m, channel, guildId } = entry;
        const guild = guildId ? this.Stores.Guild?.getGuild?.(guildId) : null;
        const s = this.settings;

        const closeBtn = h("button", { class: "pp-close", title: "閉じる", "aria-label": "閉じる" }, "×");
        const head = h("div", { class: "pp-head" },
            this.sourceIcon(guild, m),
            h("span", { class: "pp-src" }, this.sourceLabel(channel, guild)),
            h("span", { class: "pp-time" }, this.timeLabel(m)),
            closeBtn,
        );

        const main = h("div", { class: "pp-main" },
            h("div", { class: "pp-author" }, this.displayName(m.author, guildId)),
            this.renderContent(m, guildId),
        );
        const img = s.showImages && this.imageOf(m);
        if (img) main.append(h("img", { class: "pp-image", src: img, alt: "", draggable: "false" }));

        const body = h("div", { class: "pp-body" },
            h("img", { class: "pp-avatar", src: this.avatarUrl(m.author, guildId), alt: "", draggable: "false" }),
            main,
        );

        const actions = h("div", { class: "pp-actions" });
        for (const emoji of this.quickList()) {
            const b = h("button", { class: "pp-react", title: "リアクション" }, emojiNode(emoji));
            b.addEventListener("click", (e) => { e.stopPropagation(); this.react(entry, emoji, b); });
            actions.append(b);
        }
        const replyBtn = h("button", { class: "pp-act", title: "返信" }, "返信");
        replyBtn.addEventListener("click", (e) => { e.stopPropagation(); this.openReply(toast, entry); });
        actions.append(h("span", { class: "pp-spacer" }), replyBtn);

        const input = h("input", { class: "pp-reply-input", type: "text", placeholder: "返信を入力して Enter（Escで閉じる）" });
        const form = h("form", { class: "pp-reply" }, input);
        form.addEventListener("submit", (e) => { e.preventDefault(); this.sendReply(toast, entry, input); });
        for (const ev of ["keydown", "keyup", "keypress"]) {
            input.addEventListener(ev, (e) => {
                e.stopPropagation();
                if (ev === "keydown" && e.key === "Escape") { form.classList.remove("pp-open"); toast.classList.remove("pp-hold"); }
            });
        }

        const fill = h("div", { class: "pp-progress-fill" });
        const toast = h("div", { class: "pp-toast" + (s.duration > 0 ? "" : " pp-sticky"), role: "alert" },
            head, body, actions, form, h("div", { class: "pp-progress" }, fill));
        toast.style.setProperty("--pp-accent", s.markColor);
        toast.style.setProperty("--pp-duration", Math.max(1000, s.duration) + "ms");

        toast.addEventListener("animationend", (e) => {
            if (e.target !== toast) return;
            if (e.animationName === "pp-in") toast.classList.add("pp-shown");
            else if (e.animationName === "pp-out") toast.remove();
        });
        fill.addEventListener("animationend", () => this.dismiss(toast));
        closeBtn.addEventListener("click", (e) => { e.stopPropagation(); this.dismiss(toast); });
        toast.addEventListener("auxclick", (e) => { if (e.button === 1) this.dismiss(toast); });
        toast.addEventListener("contextmenu", (e) => this.openMenu(e, entry, toast));
        this.bindSwipe(toast, entry);

        this.container.prepend(toast);
        const live = [...this.container.querySelectorAll(".pp-toast:not(.pp-out)")];
        for (const old of live.slice(Math.max(1, s.maxStack))) this.dismiss(old);
    }

    // 上にスワイプで閉じる / 動かさずに離したらジャンプ
    bindSwipe(toast, entry) {
        let start = null;
        let moved = false;
        toast.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 || e.target.closest("button, input, .pp-reply")) return;
            start = { x: e.clientX, y: e.clientY };
            moved = false;
            toast.setPointerCapture?.(e.pointerId);
            toast.classList.add("pp-dragging");
        });
        toast.addEventListener("pointermove", (e) => {
            if (!start) return;
            const dy = e.clientY - start.y;
            if (Math.abs(dy) > 6 || Math.abs(e.clientX - start.x) > 6) moved = true;
            const y = dy < 0 ? dy : dy / 4; // 下方向はゴムっぽく抵抗
            toast.style.setProperty("--pp-drag", y + "px");
            toast.style.opacity = dy < 0 ? String(Math.max(0, 1 + dy / 120)) : "";
        });
        const end = (e, cancelled) => {
            if (!start) return;
            const dy = e.clientY - start.y;
            start = null;
            toast.classList.remove("pp-dragging");
            if (!cancelled && dy < -40) { this.dismiss(toast); return; }
            toast.style.setProperty("--pp-drag", "0px");
            toast.style.opacity = "";
            if (!cancelled && !moved) { this.jump(entry); this.dismiss(toast); }
        };
        toast.addEventListener("pointerup", (e) => end(e, false));
        toast.addEventListener("pointercancel", (e) => end(e, true));
    }

    dismiss(toast) {
        if (!toast || toast.classList.contains("pp-out")) return;
        toast.style.maxHeight = toast.offsetHeight + "px";
        toast.classList.add("pp-out");
        setTimeout(() => toast.remove(), 600); // animationend が来なかった時の保険
    }

    dismissAll() {
        this.container?.querySelectorAll(".pp-toast").forEach((t) => this.dismiss(t));
    }

    openMenu(e, entry, toast) {
        e.preventDefault();
        e.stopPropagation();
        const CM = BdApi.ContextMenu;
        if (!CM?.open) return;
        toast.classList.add("pp-hold");
        const release = () => { if (!toast.querySelector(".pp-reply.pp-open")) toast.classList.remove("pp-hold"); };
        clearTimeout(toast._holdTimer);
        toast._holdTimer = setTimeout(release, 20000);

        const reactItems = this.menuEmojis(entry.guildId).map((em, i) => ({
            id: "pp-react-" + i, label: em.label, action: () => this.react(entry, em.emoji),
        }));
        const items = [
            { type: "submenu", id: "pp-reactions", label: "リアクションを付ける", items: reactItems },
            { id: "pp-reply", label: "返信", action: () => this.openReply(toast, entry) },
            { id: "pp-jump", label: "メッセージへ移動", action: () => { this.jump(entry); this.dismiss(toast); } },
            { type: "separator" },
            { id: "pp-copy-text", label: "テキストをコピー", action: () => this.copy(entry.message.content || "") },
            { id: "pp-copy-link", label: "メッセージリンクをコピー", action: () => this.copy(this.messageLink(entry)) },
            { id: "pp-copy-id", label: "メッセージIDをコピー", action: () => this.copy(entry.message.id) },
            { type: "separator" },
            { id: "pp-clear-mark", label: "サーバーのマークを消す", disabled: !this.lastPing, action: () => this.clearLastPing() },
            { id: "pp-close", label: "閉じる", action: () => this.dismiss(toast) },
            { id: "pp-close-all", label: "すべて閉じる", danger: true, action: () => this.dismissAll() },
        ];
        CM.open(e, CM.buildMenu(items), { onClose: release });
    }

    openReply(toast, entry) {
        const form = toast.querySelector(".pp-reply");
        form.classList.add("pp-open");
        toast.classList.add("pp-hold");
        const input = form.querySelector("input");
        const who = this.displayName(entry.message.author, entry.guildId);
        input.placeholder = `${who} に返信（Enterで送信 / Escで閉じる）`;
        setTimeout(() => input.focus(), 0);
    }

    async sendReply(toast, entry, input) {
        const content = input.value.trim();
        if (!content) return;
        const MA = this.MessageActions;
        if (!MA?.sendMessage) {
            BdApi.UI.showToast("返信用モジュールが見つかりません。メッセージへ移動します", { type: "error" });
            this.jump(entry);
            return;
        }
        input.disabled = true;
        try {
            await MA.sendMessage(
                entry.channelId,
                { content, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] },
                undefined,
                { messageReference: { guild_id: entry.guildId || undefined, channel_id: entry.channelId, message_id: entry.message.id } },
            );
            BdApi.UI.showToast("返信しました", { type: "success" });
            this.dismiss(toast);
        } catch (err) {
            LOG(err);
            input.disabled = false;
            BdApi.UI.showToast("返信に失敗しました", { type: "error" });
        }
    }

    // --- actions ---

    jump(entry) {
        const path = `/channels/${entry.guildId || "@me"}/${entry.channelId}/${entry.message.id}`;
        try { if (this.transitionTo) { this.transitionTo(path); return; } } catch (e) { LOG(e); }
        try {
            if (this.MessageActions?.jumpToMessage) {
                this.MessageActions.jumpToMessage({ channelId: entry.channelId, messageId: entry.message.id, flash: true });
                return;
            }
        } catch (e) { LOG(e); }
        history.pushState({}, "", path);
        window.dispatchEvent(new PopStateEvent("popstate"));
    }

    async react(entry, emoji, btn) {
        try {
            if (!this.ReactionActions) throw new Error("reaction module not found");
            await this.ReactionActions.addReaction(entry.channelId, entry.message.id, emoji);
            btn?.classList.add("pp-reacted");
        } catch (err) {
            LOG(err);
            BdApi.UI.showToast("リアクションに失敗しました", { type: "error" });
        }
    }

    copy(text) {
        try {
            if (window.DiscordNative?.clipboard?.copy) window.DiscordNative.clipboard.copy(text);
            else navigator.clipboard.writeText(text);
            BdApi.UI.showToast("コピーしました", { type: "success" });
        } catch (e) { LOG(e); }
    }

    messageLink(entry) {
        return `https://discord.com/channels/${entry.guildId || "@me"}/${entry.channelId}/${entry.message.id}`;
    }

    quickList() {
        return String(this.settings.quickReactions || "")
            .split(/\s+/).filter(Boolean).map(parseEmoji).slice(0, 8);
    }

    // 右クリックメニュー用：よく使う絵文字 + クイックリアクション
    menuEmojis(guildId) {
        const out = [];
        const seen = new Set();
        const push = (emoji, label) => {
            const k = emoji.id || emoji.name;
            if (!k || seen.has(k)) return;
            seen.add(k);
            out.push({ emoji, label });
        };
        try {
            const ctx = this.Stores.Emoji?.getDisambiguatedEmojiContext?.(guildId);
            const fr = ctx?.getFrequentlyUsedReactionEmojisWithoutFetchingLatest?.()
                ?? ctx?.getFrequentlyUsedEmojisWithoutFetchingLatest?.() ?? [];
            const arr = Array.isArray(fr) ? fr : (fr?.toArray?.() ?? []);
            for (const e of arr.slice(0, 10)) {
                if (e?.id) push({ id: e.id, name: e.name, animated: !!e.animated }, `:${e.name}:`);
                else if (e?.surrogates) push({ id: null, name: e.surrogates, animated: false }, `${e.surrogates}  :${e.name}:`);
            }
        } catch {}
        for (const e of this.quickList()) push(e, e.id ? `:${e.name}:` : e.name);
        return out.slice(0, 16);
    }

    // --- rendering helpers ---

    displayName(author, guildId) {
        if (!author) return "不明なユーザー";
        const GM = this.Stores.GuildMember;
        const nick = guildId && (GM?.getNick?.(guildId, author.id) || GM?.getMember?.(guildId, author.id)?.nick);
        return nick || author.global_name || author.globalName || author.username || "不明なユーザー";
    }

    avatarUrl(author, guildId) {
        if (!author) return "https://cdn.discordapp.com/embed/avatars/0.png";
        try {
            const rec = typeof author.getAvatarURL === "function" ? author : this.Stores.User?.getUser?.(author.id);
            const url = rec?.getAvatarURL?.(guildId, 80);
            if (url) return url;
        } catch {}
        if (author.avatar) {
            const ext = author.avatar.startsWith("a_") ? "gif" : "png";
            return `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.${ext}?size=80`;
        }
        let idx = 0;
        try {
            idx = author.discriminator && author.discriminator !== "0"
                ? Number(author.discriminator) % 5
                : Number((BigInt(author.id) >> 22n) % 6n);
        } catch {}
        return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
    }

    sourceIcon(guild, m) {
        if (guild?.icon) {
            return h("img", { class: "pp-gicon", src: `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=32`, alt: "", draggable: "false" });
        }
        if (guild) {
            const ac = guild.acronym || String(guild.name || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 3);
            return h("span", { class: "pp-gicon pp-gicon-text" }, ac);
        }
        return h("span", { class: "pp-gicon pp-gicon-text" }, "DM");
    }

    sourceLabel(channel, guild) {
        if (guild) {
            let ch = channel?.name ? `#${channel.name}` : "";
            if (channel && (channel.type === 11 || channel.type === 12) && channel.parent_id) {
                const parent = this.Stores.Channel?.getChannel?.(channel.parent_id);
                if (parent?.name) ch = `#${parent.name} › ${channel.name}`;
            }
            return ch ? `${guild.name} › ${ch}` : guild.name;
        }
        if (channel?.type === 3) {
            if (channel.name) return channel.name;
            const names = (channel.recipients || []).map((id) => {
                const u = this.Stores.User?.getUser?.(id);
                return u?.globalName || u?.username;
            }).filter(Boolean);
            return names.length ? names.join(", ") : "グループDM";
        }
        return "ダイレクトメッセージ";
    }

    timeLabel(m) {
        const d = m.timestamp ? new Date(m.timestamp) : new Date();
        if (isNaN(d) || Date.now() - d.getTime() < 60000) return "今";
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }

    renderContent(m, guildId) {
        const wrap = h("div", { class: "pp-content" });
        const raw = String(m.content || "").replace(/\|\|[\s\S]+?\|\|/g, "［スポイラー］");
        const re = /<(@!?|@&|#)(\d+)>|<(a?):(\w+):(\d+)>/g;
        let last = 0;
        let mt;
        while ((mt = re.exec(raw))) {
            if (mt.index > last) wrap.append(raw.slice(last, mt.index));
            if (mt[1]) wrap.append(this.mentionNode(mt[1], mt[2], guildId));
            else wrap.append(emojiNode({ id: mt[5], name: mt[4], animated: !!mt[3] }));
            last = re.lastIndex;
        }
        if (last < raw.length) wrap.append(raw.slice(last));
        if (!raw.trim()) {
            const extra = this.extraLabel(m);
            if (extra) wrap.append(h("span", { class: "pp-dim" }, extra));
        }
        return wrap;
    }

    mentionNode(kind, id, guildId) {
        const S = this.Stores;
        let label = "";
        if (kind === "#") {
            label = "#" + (S.Channel?.getChannel?.(id)?.name || "不明なチャンネル");
        } else if (kind === "@&") {
            const role = S.GuildRole?.getRole?.(guildId, id) || S.Guild?.getRole?.(guildId, id) || S.Guild?.getGuild?.(guildId)?.roles?.[id];
            label = "@" + (role?.name || "不明なロール");
        } else {
            const u = S.User?.getUser?.(id);
            label = "@" + (u ? this.displayName(u, guildId) : "不明なユーザー");
        }
        return h("span", { class: "pp-mention" }, label);
    }

    extraLabel(m) {
        const stickers = m.sticker_items || m.stickerItems || m.stickers || [];
        if (stickers.length) return `［スタンプ: ${stickers[0].name}］`;
        const att = m.attachments || [];
        if (att.length) {
            if (this.settings.showImages && this.imageOf(m)) return "";
            return `［添付ファイル: ${att[0].filename}${att.length > 1 ? ` ほか${att.length - 1}件` : ""}］`;
        }
        const em = (m.embeds || [])[0];
        if (em) return em.title || em.rawTitle || em.description || em.rawDescription || "［埋め込み］";
        if (m.poll) return "［投票］";
        return "";
    }

    imageOf(m) {
        const a = (m.attachments || []).find((x) =>
            !String(x.filename || "").startsWith("SPOILER_") &&
            ((x.content_type || x.contentType || "").startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(x.filename || "")));
        return a ? (a.proxy_url || a.url) : null;
    }

    // --- test ---

    test() {
        const S = this.Stores;
        const cid = S.SelectedChannel?.getChannelId?.();
        const channel = cid ? S.Channel?.getChannel?.(cid) : null;
        let msg = null;
        try { msg = S.Message?.getMessages?.(cid)?.toArray?.().filter((x) => x.author).at(-1) || null; } catch {}
        if (!msg) {
            msg = {
                id: String(Date.now()),
                content: "これはテスト通知です 👋 クリックでジャンプ / 右クリックでメニュー / 上にスワイプで閉じる",
                author: S.User?.getCurrentUser?.() || { id: "0", username: "PingPeek" },
                timestamp: new Date().toISOString(),
                attachments: [], embeds: [],
            };
        }
        const entry = { message: msg, channelId: cid, guildId: channel?.guild_id || null, channel, t: Date.now(), likely: true };
        this.showToast(entry);
        if (cid) this.setLastPing(entry);
    }

    // --- CSS ---

    injectCSS() {
        BdApi.DOM.addStyle(this.name + "-base", `
.pp-container {
    position: fixed; top: var(--pp-top, 36px); left: 50%; transform: translateX(-50%);
    z-index: 1000; width: min(var(--pp-width, 420px), calc(100vw - 32px));
    display: flex; flex-direction: column; align-items: stretch; gap: 8px; pointer-events: none;
}
.pp-toast {
    --pp-drag: 0px;
    pointer-events: auto; position: relative; box-sizing: border-box; overflow: hidden;
    padding: 10px 12px 12px 16px; border-radius: 16px; cursor: pointer; user-select: none; touch-action: none;
    background: color-mix(in srgb, var(--background-floating, #111214) 90%, transparent);
    -webkit-backdrop-filter: blur(16px) saturate(1.4); backdrop-filter: blur(16px) saturate(1.4);
    color: var(--text-normal, var(--text-default, #dbdee1));
    box-shadow: 0 12px 32px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.07);
    font-family: var(--font-primary, "gg sans", "Noto Sans JP", sans-serif);
    transform: translateY(var(--pp-drag));
    transition: transform .3s cubic-bezier(.2,1,.3,1), opacity .25s, box-shadow .2s;
    animation: pp-in .55s cubic-bezier(.2,1.25,.35,1) both;
}
.pp-toast.pp-shown { animation: none; }
.pp-toast.pp-dragging { transition: none; cursor: grabbing; }
.pp-toast:hover { box-shadow: 0 14px 36px rgba(0,0,0,.5), 0 0 0 1px color-mix(in srgb, var(--pp-accent) 55%, transparent); }
.pp-toast::before {
    content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--pp-accent);
}
.pp-toast.pp-out {
    animation: pp-out .3s cubic-bezier(.4,0,1,1) forwards; pointer-events: none;
}
@keyframes pp-in {
    from { transform: translateY(calc(-100% - 48px)) scale(.94); opacity: 0; }
    to   { transform: translateY(0) scale(1); opacity: 1; }
}
@keyframes pp-out {
    to { transform: translateY(-28px) scale(.95); opacity: 0; max-height: 0; margin-bottom: -8px; padding-top: 0; padding-bottom: 0; }
}
.pp-head { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-muted, #949ba4); margin-bottom: 6px; }
.pp-gicon { width: 16px; height: 16px; border-radius: 5px; flex: none; object-fit: cover; }
.pp-gicon-text {
    display: inline-flex; align-items: center; justify-content: center; font-size: 8px; font-weight: 700;
    background: var(--background-modifier-accent, #3f4147); color: var(--text-normal, #dbdee1);
}
.pp-src { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.pp-time { flex: none; }
.pp-close {
    flex: none; width: 20px; height: 20px; border: 0; border-radius: 50%; padding: 0; cursor: pointer;
    background: transparent; color: var(--interactive-normal, #b5bac1); font-size: 16px; line-height: 20px;
    opacity: 0; transition: opacity .15s, background .15s;
}
.pp-toast:hover .pp-close { opacity: 1; }
.pp-close:hover { background: var(--background-modifier-hover, rgba(255,255,255,.08)); color: var(--interactive-hover, #fff); }
.pp-body { display: flex; gap: 10px; align-items: flex-start; }
.pp-avatar { width: 36px; height: 36px; border-radius: 50%; flex: none; object-fit: cover; }
.pp-main { flex: 1; min-width: 0; }
.pp-author { font-weight: 600; font-size: 14px; color: var(--header-primary, var(--text-strong, #f2f3f5)); margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pp-content {
    font-size: 14px; line-height: 1.375; white-space: pre-wrap; overflow-wrap: anywhere;
    display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
}
.pp-emoji { width: 1.375em; height: 1.375em; vertical-align: bottom; object-fit: contain; }
.pp-mention { color: var(--pp-accent); background: color-mix(in srgb, var(--pp-accent) 18%, transparent); border-radius: 3px; padding: 0 2px; font-weight: 500; }
.pp-dim { color: var(--text-muted, #949ba4); font-style: italic; }
.pp-image { display: block; margin-top: 6px; max-width: 100%; max-height: 160px; border-radius: 8px; object-fit: cover; }
.pp-actions {
    display: flex; align-items: center; gap: 4px; max-height: 0; opacity: 0; margin-top: 0; overflow: hidden;
    transition: max-height .25s cubic-bezier(.2,1,.3,1), opacity .2s, margin-top .25s;
}
.pp-toast:hover .pp-actions, .pp-toast.pp-hold .pp-actions { max-height: 40px; opacity: 1; margin-top: 8px; }
.pp-spacer { flex: 1; }
.pp-react, .pp-act {
    border: 0; cursor: pointer; border-radius: 999px; height: 28px; padding: 0 9px; font-size: 15px;
    background: var(--background-modifier-hover, rgba(255,255,255,.06)); color: var(--text-normal, #dbdee1);
    transition: transform .15s cubic-bezier(.2,1.5,.4,1), background .15s;
    display: inline-flex; align-items: center;
}
.pp-act { font-size: 12px; font-weight: 600; }
.pp-react:hover, .pp-act:hover { background: var(--background-modifier-active, rgba(255,255,255,.12)); transform: scale(1.12); }
.pp-react:active, .pp-act:active { transform: scale(.94); }
.pp-react.pp-reacted { background: color-mix(in srgb, var(--pp-accent) 30%, transparent); box-shadow: inset 0 0 0 1px var(--pp-accent); }
.pp-react .pp-emoji { width: 18px; height: 18px; }
.pp-reply { display: none; margin-top: 8px; }
.pp-reply.pp-open { display: block; }
.pp-reply-input {
    width: 100%; box-sizing: border-box; height: 34px; border-radius: 8px; padding: 0 10px; font-size: 14px;
    border: 1px solid var(--background-modifier-accent, rgba(255,255,255,.1)); outline: none;
    background: var(--channeltextarea-background, var(--background-secondary, #2b2d31)); color: var(--text-normal, #dbdee1);
}
.pp-reply-input:focus { border-color: var(--pp-accent); }
.pp-progress { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; }
.pp-progress-fill {
    height: 100%; background: var(--pp-accent); opacity: .7; transform-origin: left;
    animation: pp-progress var(--pp-duration, 6s) linear forwards;
}
.pp-toast.pp-sticky .pp-progress { display: none; }
.pp-toast:hover .pp-progress-fill, .pp-toast.pp-hold .pp-progress-fill,
.pp-container.pp-unfocused .pp-progress-fill { animation-play-state: paused; }
@keyframes pp-progress { from { transform: scaleX(1); } to { transform: scaleX(0); } }
@media (prefers-reduced-motion: reduce) {
    .pp-toast { animation-duration: .01s; transition: none; }
    .pp-toast.pp-out { animation-duration: .01s; }
}

.pp-settings { color: var(--text-normal, #dbdee1); display: flex; flex-direction: column; gap: 14px; font-size: 14px; }
.pp-settings h3 { margin: 6px 0 0; font-size: 12px; font-weight: 700; text-transform: uppercase; color: var(--header-secondary, #b5bac1); letter-spacing: .02em; }
.pp-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.pp-row label { flex: 1; }
.pp-row small { display: block; color: var(--text-muted, #949ba4); font-size: 12px; margin-top: 2px; }
.pp-row input[type=number], .pp-row input[type=text], .pp-row select {
    background: var(--input-background, var(--background-tertiary, #1e1f22)); color: var(--text-normal, #dbdee1);
    border: 1px solid var(--background-modifier-accent, rgba(255,255,255,.1)); border-radius: 6px; padding: 6px 8px; font-size: 14px;
}
.pp-row input[type=number] { width: 90px; }
.pp-row input[type=text] { width: 220px; }
.pp-row input[type=color] { width: 48px; height: 30px; border: 0; background: none; cursor: pointer; }
.pp-row input[type=checkbox] { width: 18px; height: 18px; accent-color: var(--pp-accent, #5865f2); }
.pp-btns { display: flex; gap: 8px; flex-wrap: wrap; }
.pp-btn { border: 0; border-radius: 6px; padding: 8px 14px; cursor: pointer; font-weight: 600; background: var(--brand-experiment, var(--brand-500, #5865f2)); color: #fff; }
.pp-btn.pp-secondary { background: var(--background-modifier-accent, #4e5058); }
.pp-status { font-size: 12px; color: var(--text-muted, #949ba4); line-height: 1.6; }
.pp-ok { color: var(--status-positive, #23a55a); }
.pp-ng { color: var(--status-danger, #f23f43); }
`);
    }

    // --- settings ---

    getSettingsPanel() {
        const s = this.settings;
        const panel = h("div", { class: "pp-settings" });
        panel.style.setProperty("--pp-accent", s.markColor);

        const set = (key, val) => {
            s[key] = val;
            this.saveSettings();
            this.applyContainerVars();
            this.updateMarkCSS();
            this.onWinFocus?.();
            if (key === "markColor") panel.style.setProperty("--pp-accent", val);
        };
        const row = (label, hint, control) =>
            h("div", { class: "pp-row" }, h("label", {}, label, hint ? h("small", {}, hint) : null), control);
        const check = (key) => {
            const el = h("input", { type: "checkbox" });
            el.checked = !!s[key];
            el.addEventListener("change", () => set(key, el.checked));
            return el;
        };
        const num = (key, min, max, step = 1, scale = 1) => {
            const el = h("input", { type: "number", min, max, step });
            el.value = s[key] / scale;
            el.addEventListener("change", () => {
                const v = Math.min(max, Math.max(min, Number(el.value) || 0));
                el.value = v;
                set(key, Math.round(v * scale));
            });
            return el;
        };
        const text = (key) => {
            const el = h("input", { type: "text" });
            el.value = s[key];
            el.addEventListener("change", () => set(key, el.value));
            return el;
        };
        const color = (key) => {
            const el = h("input", { type: "color" });
            el.value = s[key];
            el.addEventListener("input", () => set(key, el.value));
            return el;
        };
        const mode = h("select", {},
            h("option", { value: "sound" }, "通知音が鳴った時だけ（推奨）"),
            h("option", { value: "logic" }, "通知設定から判定"));
        mode.value = s.mode;
        mode.addEventListener("change", () => set("mode", mode.value));

        const status = h("div", { class: "pp-status" },
            "検出状況: ",
            ...Object.entries(this.moduleStatus || {}).flatMap(([k, ok]) => [
                h("span", { class: ok ? "pp-ok" : "pp-ng" }, `${ok ? "✓" : "✗"} ${k}`), "　",
            ]));

        panel.append(
            h("h3", {}, "プレビュー"),
            row("表示するタイミング", "「通知音」は実際にピコンと鳴った時に連動。Discordの通知音をOFFにしている場合は「通知設定から判定」を使ってください", mode),
            row("表示時間（秒）", "0 で自動では消えない", num("duration", 0, 60, 0.5, 1000)),
            row("同時に表示する数", null, num("maxStack", 1, 6)),
            row("上端からの位置（px）", "タイトルバーに被る場合は大きく", num("topOffset", 0, 400)),
            row("幅（px）", null, num("width", 280, 700)),
            row("今見ているチャンネルの通知も表示", null, check("showWhenViewing")),
            row("Discordが非アクティブな間はタイマーを止める", "戻ってきた時に見逃さないように", check("pauseWhenUnfocused")),
            row("画像をプレビュー", null, check("showImages")),
            row("クイックリアクション", "スペース区切り。カスタム絵文字は <:name:id> 形式", text("quickReactions")),
            row("通知音との紐付け猶予（ms）", "通常は変更不要", num("matchWindow", 300, 5000, 100)),

            h("h3", {}, "最後に通知したサーバーのマーク"),
            row("マークの色", null, color("markColor")),
            row("アイコンの周りを光らせる", null, check("markRing")),
            row("光を脈動させる", null, check("markPulse")),
            row("通知数バッジ（右下の赤丸）の色を変える", "数字はそのまま", check("markBadge")),
            row("左の未読ピルの色を変える", null, check("markPill")),
            row("チャンネル一覧の該当チャンネルも色付け", null, check("markChannel")),
            row("そのサーバーを開いたらマークを消す", null, check("clearOnVisit")),

            h("div", { class: "pp-btns" },
                btn("テスト表示", () => this.test()),
                btn("マークを消す", () => this.clearLastPing(), true)),
            status,
        );
        return panel;
    }
};

// --- utils ---

function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v == null || v === false) continue;
        if (k === "class") el.className = v;
        else el.setAttribute(k, v);
    }
    for (const c of kids.flat()) {
        if (c == null || c === false) continue;
        el.append(c instanceof Node ? c : String(c));
    }
    return el;
}

function btn(label, onClick, secondary) {
    const b = h("button", { class: "pp-btn" + (secondary ? " pp-secondary" : "") }, label);
    b.addEventListener("click", onClick);
    return b;
}

function parseEmoji(token) {
    const m = /^<(a?):(\w+):(\d+)>$/.exec(token);
    if (m) return { id: m[3], name: m[2], animated: !!m[1] };
    return { id: null, name: token, animated: false };
}

function emojiNode(emoji) {
    if (!emoji.id) return document.createTextNode(emoji.name);
    return h("img", {
        class: "pp-emoji", alt: `:${emoji.name}:`, title: `:${emoji.name}:`, draggable: "false",
        src: `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? "gif" : "webp"}?size=48`,
    });
}

function contrastText(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return "#fff";
    const n = parseInt(m[1], 16);
    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return L > 0.4 ? "#000" : "#fff";
}
