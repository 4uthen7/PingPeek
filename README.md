<div align="center">

# PingPeek

**「今のピコン、どこから？」をなくす Discord プラグイン**

通知音が鳴ったメッセージをスマホの通知のように上から表示し、<br>
最後に通知してきたサーバーをサイドバーで目立たせます。

[BetterDiscord](#betterdiscord) ・ [Vencord](#vencord) ・ [English](#english)

</div>

---

## 機能

### 📩 通知プレビュー
- 通知音が鳴ると、そのメッセージがウィンドウ上部中央から降りてくる
- サーバー名・チャンネル名・送信者・本文・画像を表示（スポイラーは伏せ字）
- **クリック** でそのメッセージへジャンプ
- **ホバー** でクイックリアクションと返信ボタン
- **右クリック** でメニュー（リアクション / 返信 / 移動 / テキスト・リンク・IDのコピー / 閉じる）
- カード内からそのまま **返信** を送信
- **上にスワイプ** または **中クリック** で閉じる
- ホバー中・Discord が非アクティブな間は自動で消えない

### 🎯 最後に通知したサーバーのマーク
- サーバーアイコンを好きな色で光らせる（脈動あり/なし）
- 右下の通知数バッジを、**数字はそのまま** 好きな色に
- 左の未読ピル、チャンネル一覧の該当チャンネルも同じ色に
- 「開いたら消す」設定も可能

## 仕組み

Discord の通知音再生（`playSound`）をフックし、直前に届いたメッセージと時刻で照合しています。
Discord 自身が「鳴らす」と判断したメッセージだけが表示されるので、ミュートや通知設定とズレません。

Discord の通知音を OFF にしている場合は、設定で **「通知設定から判定」** に切り替えると、サーバー/チャンネルの通知設定・ミュート・メンションから判定します。

## インストール

### BetterDiscord

1. [`betterdiscord/PingPeek.plugin.js`](betterdiscord/PingPeek.plugin.js) をダウンロード
2. `%appdata%\BetterDiscord\plugins` に置く
3. 設定 → BetterDiscord → プラグイン で PingPeek を有効化
4. 歯車アイコンから設定を開き「テスト表示」で確認

### Vencord

Vencord のユーザープラグインとしてビルドする必要があります（[公式ガイド](https://docs.vencord.dev/installing/custom-plugins/)）。

1. Vencord をソースからセットアップ
2. [`vencord/pingPeek`](vencord/pingPeek) フォルダを `Vencord/src/userplugins/` にコピー
3. `pnpm build` → `pnpm inject`
4. 設定 → Vencord → プラグイン で PingPeek を有効化

## 設定

| 項目 | 説明 |
|---|---|
| 表示するタイミング | 通知音に連動 / 通知設定から判定 |
| 表示時間 | 0 で自動では消えない |
| 同時表示数・位置・幅 | タイトルバーに被る場合は位置を下げる |
| クイックリアクション | スペース区切り。カスタム絵文字は `<:name:id>` |
| マークの色 | リング・バッジ・ピル・チャンネルの色 |
| 各マークの ON/OFF | リング / 脈動 / バッジ / ピル / チャンネル |
| 開いたらマークを消す | 確認したらマークを外す |

## 既知の制限

- 折りたたまれたサーバーフォルダ内のサーバーは、フォルダを開くまでマークが見えません
- Discord のアップデートで内部構造が変わると、一部機能が動かなくなることがあります（BD 版は設定画面下部の「検出状況」で確認できます）

## 注意

クライアント改造は Discord の利用規約に反する可能性があります。自己責任でご利用ください。

## ライセンス

[MIT](LICENSE)

---

## English

**PingPeek** shows a phone-style preview of the message that just triggered Discord's notification sound, dropping in from the top-center of the window, and highlights the server that pinged you last.

- Click to jump, hover for quick reactions, right-click for a menu (react / reply / jump / copy / dismiss)
- Reply inline, swipe up or middle-click to dismiss
- Last-pinged server: glowing ring, recolored mention badge (count kept), pill and channel highlight in a color of your choice
- Works with **BetterDiscord** (`betterdiscord/PingPeek.plugin.js`) and **Vencord** (copy `vencord/pingPeek` into `src/userplugins` and rebuild)

The UI is in Japanese for now. Use at your own risk — client mods may violate Discord's Terms of Service.
