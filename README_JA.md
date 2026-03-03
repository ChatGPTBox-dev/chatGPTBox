<p align="center">
    <img src="./src/logo.png">
</p>

<h1 align="center">ChatGPT Box</h1>

<div align="center">

深い ChatGPT 統合をブラウザに、完全無料で。

[![license][license-image]][license-url]
[![release][release-image]][release-url]
[![size](https://img.shields.io/badge/minified%20size-390%20kB-blue)][release-url]
[![verfiy][verify-image]][verify-url]

[English](README.md) &nbsp;&nbsp;|&nbsp;&nbsp; [Indonesia](README_IN.md) &nbsp;&nbsp;|&nbsp;&nbsp; [简体中文](README_ZH.md) &nbsp;&nbsp;|&nbsp;&nbsp; 日本語 &nbsp;&nbsp;|&nbsp;&nbsp; [Türkçe](README_TR.md)

### インストール

[![Chrome][Chrome-image]][Chrome-url]
[![Edge][Edge-image]][Edge-url]
[![Firefox][Firefox-image]][Firefox-url]
[![Safari][Safari-image]][Safari-url]
[![Android][Android-image]][Android-url]
[![Github][Github-image]][Github-url]

[ガイド](https://github.com/ChatGPTBox-dev/chatGPTBox/wiki/Guide) &nbsp;&nbsp;|&nbsp;&nbsp; [プレビュー](#プレビュー) &nbsp;&nbsp;|&nbsp;&nbsp; [開発 & コントリビュート][dev-url] &nbsp;&nbsp;|&nbsp;&nbsp; [ビデオデモ](https://www.youtube.com/watch?v=E1smDxJvTRs) &nbsp;&nbsp;|&nbsp;&nbsp; [クレジット](#クレジット)

[dev-url]: https://github.com/ChatGPTBox-dev/chatGPTBox/wiki/Development&Contributing

[license-image]: http://img.shields.io/badge/license-MIT-blue.svg

[license-url]: https://github.com/ChatGPTBox-dev/chatGPTBox/blob/master/LICENSE

[release-image]: https://img.shields.io/github/release/ChatGPTBox-dev/chatGPTBox.svg

[release-url]: https://github.com/ChatGPTBox-dev/chatGPTBox/releases/latest

[verify-image]: https://github.com/ChatGPTBox-dev/chatGPTBox/workflows/verify-configs/badge.svg

[verify-url]: https://github.com/ChatGPTBox-dev/chatGPTBox/actions/workflows/verify-configs.yml

[Chrome-image]: https://img.shields.io/badge/-Chrome-brightgreen?logo=google-chrome&logoColor=white

[Chrome-url]: https://chromewebstore.google.com/detail/chatgptbox/eobbhoofkanlmddnplfhnmkfbnlhpbbo

[Edge-image]: https://img.shields.io/badge/-Edge-blue?logo=microsoft-edge&logoColor=white

[Edge-url]: https://microsoftedge.microsoft.com/addons/detail/fission-chatbox-best/enjmfilpkbbabhgeoadmdpjjpnahkogf

[Firefox-image]: https://img.shields.io/badge/-Firefox-orange?logo=firefox-browser&logoColor=white

[Firefox-url]: https://addons.mozilla.org/firefox/addon/chatgptbox/

[Safari-image]: https://img.shields.io/badge/-Safari-blue?logo=safari&logoColor=white

[Safari-url]: https://apps.apple.com/app/fission-chatbox/id6446611121

[Android-image]: https://img.shields.io/badge/-Android-brightgreen?logo=android&logoColor=white

[Android-url]: https://github.com/ChatGPTBox-dev/chatGPTBox/wiki/Install#install-to-android

[Github-image]: https://img.shields.io/badge/-Github-black?logo=github&logoColor=white

[Github-url]: https://github.com/ChatGPTBox-dev/chatGPTBox/wiki/Install

</div>

## ニュース

- この拡張機能はあなたのデータを収集しません。コード内の `fetch(` と `XMLHttpRequest(` をグローバル検索して、すべてのネットワークリクエストの呼び出しを見つけることで確認できます。コードの量はそれほど多くないので、簡単にできます。

- このツールは、あなたが明示的に要求しない限り、ChatGPT にデータを送信しません。デフォルトでは、拡張機能は手動で有効にする必要があります ChatGPT へのリクエストは、"Ask ChatGPT" をクリックするか、選択フローティングツールをトリガーした場合にのみ送信されます。(issue #407)

- https://github.com/BerriAI/litellm / https://github.com/songquanpeng/one-api のようなプロジェクトを使用して、LLM APIをOpenAI形式に変換し、それらをChatGPTBoxの `カスタムモデル` モードと組み合わせて使用することができます

- もちろんです。ChatGPTBoxの `カスタムモデル` モードを使用する際には、[Ollama](https://github.com/ChatGPTBox-dev/chatGPTBox/issues/616#issuecomment-1975186467) / https://openrouter.ai/docs#models もご利用いただけます

## ✨ 機能

- 🌈 いつでもどのページでもチャットダイアログボックスを呼び出すことができます。 (<kbd>Ctrl</kbd>+<kbd>B</kbd>)
- 📱 モバイル機器のサポート。
- 📓 右クリックメニューで任意のページを要約。 (<kbd>Alt</kbd>+<kbd>B</kbd>)
- 📖 独立した会話ページ。 (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>)
- 🔗 複数の API をサポート（無料および Plus ユーザー向け Web API、GPT-3.5、GPT-4、Claude、New Bing、Moonshot、セルフホスト、Azure など）。
- 📦 よく使われる様々なウェブサイト（Reddit、Quora、YouTube、GitHub、GitLab、StackOverflow、Zhihu、Bilibili）の統合。 ([wimdenherder](https://github.com/wimdenherder) にインスパイアされました)
- 🔍 すべての主要検索エンジンと統合し、追加のサイトをサポートするためのカスタムクエリ。
- 🧰 選択ツールと右クリックメニューで、翻訳、要約、推敲、感情分析、段落分割、コード説明、クエリーなど、さまざまなタスクを実行できます。
- 🗂️ 静的なカードは、複数の支店での会話のためのフローティングチャットボックスをサポートしています。
- 🖨️ チャット記録を完全に保存することも、部分的にコピーすることも簡単です。
- 🎨 コードのハイライトや複雑な数式など、強力なレンダリングをサポート。
- 🌍 言語設定のサポート。
- 📝 カスタム API アドレスのサポート
- ⚙️ すべてのサイト適応と選択ツール（バブル）は、自由にオンまたはオフに切り替えることができ、不要なモジュールを無効にすることができます。
- 💡 セレクションツールやサイトへの適応は簡単に開発・拡張できます。[開発 & コントリビュート][dev-url]のセクションを参照。
- 😉 チャットして回答の質を高められます。

## プレビュー

<div align="center">

**検索エンジンの統合、フローティングウィンドウ、会話ブランチ**

![preview_google_floatingwindow_conversationbranch](screenshots/preview_google_floatingwindow_conversationbranch.jpg)

**よく使われるウェブサイトや選択ツールとの統合**

![preview_reddit_selectiontools](screenshots/preview_reddit_selectiontools.jpg)

**独立会話ページ**

![preview_independentpanel](screenshots/preview_independentpanel.jpg)

**Git 分析、右クリックメニュー**

![preview_github_rightclickmenu](screenshots/preview_github_rightclickmenu.jpg)

**ビデオ要約**

![preview_youtube](screenshots/preview_youtube.jpg)

**モバイルサポート**

![image](https://user-images.githubusercontent.com/13366013/225529110-9221c8ce-ad41-423e-b6ec-097981e74b66.png)

**設定**

![preview_settings](screenshots/preview_settings.jpg)

</div>

## クレジット

このプロジェクトは、私の他のリポジトリ [josStorer/chatGPT-search-engine-extension](https://github.com/josStorer/chatGPT-search-engine-extension) に基づいています

[josStorer/chatGPT-search-engine-extension](https://github.com/josStorer/chatGPT-search-engine-extension) は [wong2/chat-gpt-google-extension](https://github.com/wong2/chat-gpt-google-extension) (参考にしました)からフォークされ、2022年12月14日から切り離されています

[wong2/chat-gpt-google-extension](https://github.com/wong2/chat-gpt-google-extension) は [ZohaibAhmed/ChatGPT-Google](https://github.com/ZohaibAhmed/ChatGPT-Google) にインスパイアされています([upstream-c54528b](https://github.com/wong2/chatgpt-google-extension/commit/c54528b0e13058ab78bfb433c92603db017d1b6b))
