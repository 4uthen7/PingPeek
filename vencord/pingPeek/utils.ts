/*
 * PingPeek
 * Copyright (c) 2026 4uthen7
 * SPDX-License-Identifier: MIT
 */

export interface ReactionEmoji {
    id: string | null;
    name: string;
    animated: boolean;
}

type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Record<string, string | null | undefined | false> = {},
    ...kids: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
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

export function parseEmoji(token: string): ReactionEmoji {
    const m = /^<(a?):(\w+):(\d+)>$/.exec(token);
    if (m) return { id: m[3], name: m[2], animated: !!m[1] };
    return { id: null, name: token, animated: false };
}

export function emojiNode(emoji: ReactionEmoji): Node {
    if (!emoji.id) return document.createTextNode(emoji.name);
    return h("img", {
        class: "pp-emoji",
        alt: `:${emoji.name}:`,
        title: `:${emoji.name}:`,
        draggable: "false",
        src: `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? "gif" : "webp"}?size=48`
    });
}

export function contrastText(hex: string) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return "#fff";
    const n = parseInt(m[1], 16);
    const lin = (c: number) => {
        c /= 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return L > 0.4 ? "#000" : "#fff";
}

export function defaultAvatar(id: string, discriminator?: string) {
    let idx = 0;
    try {
        idx = discriminator && discriminator !== "0"
            ? Number(discriminator) % 5
            : Number((BigInt(id) >> 22n) % 6n);
    } catch { }
    return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}
