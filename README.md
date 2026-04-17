<p align="center">
    <img src="./src/logo.png">
</p>

<h1 align="center">ChatGPT Box</h1>

<div align="center">

Deep ChatGPT integrations in your browser, completely for free.

[![license][license-image]][license-url]
[![release][release-image]][release-url]
[![size](https://img.shields.io/badge/minified%20size-390%20kB-blue)][release-url]
[![verfiy][verify-image]][verify-url]
[![coverage][coverage-image]][coverage-url]

English &nbsp;&nbsp;|&nbsp;&nbsp; [Indonesia](README_IN.md) &nbsp;&nbsp;|&nbsp;&nbsp; [简体中文](README_ZH.md) &nbsp;&nbsp;|&nbsp;&nbsp; [日本語](README_JA.md) &nbsp;&nbsp;|&nbsp;&nbsp; [Türkçe](README_TR.md)

### Install

[![Chrome][Chrome-image]][Chrome-url]
[![Edge][Edge-image]][Edge-url]
[![Firefox][Firefox-image]][Firefox-url]
[![Safari][Safari-image]][Safari-url]
[![Android][Android-image]][Android-url]
[![Github][Github-image]][Github-url]

[Guide](https://github.com/ChatGPTBox-dev/chatGPTBox/wiki/Guide) &nbsp;&nbsp;|&nbsp;&nbsp; [Preview](#Preview) &nbsp;&nbsp;|&nbsp;&nbsp; [Development&Contributing][dev-url] &nbsp;&nbsp;|&nbsp;&nbsp; [Video Demonstration](https://www.youtube.com/watch?v=E1smDxJvTRs) &nbsp;&nbsp;|&nbsp;&nbsp; [Credit](#Credit)

[dev-url]: https://github.com/ChatGPTBox-dev/chatGPTBox/wiki/Development&Contributing

[license-image]: http://img.shields.io/badge/license-MIT-blue.svg

[license-url]: https://github.com/ChatGPTBox-dev/chatGPTBox/blob/master/LICENSE

[release-image]: https://img.shields.io/github/release/ChatGPTBox-dev/chatGPTBox.svg

[release-url]: https://github.com/ChatGPTBox-dev/chatGPTBox/releases/latest

[verify-image]: https://github.com/ChatGPTBox-dev/chatGPTBox/workflows/verify-configs/badge.svg

[verify-url]: https://github.com/ChatGPTBox-dev/chatGPTBox/actions/workflows/verify-configs.yml

[coverage-image]: https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/ChatGPTBox-dev/chatGPTBox/master/badges/coverage.json

[coverage-url]: https://github.com/ChatGPTBox-dev/chatGPTBox/actions/workflows/pr-tests.yml

[Chrome-image]: https://img.shields.io/badge/-Chrome-brightgreen?logo=google-chrome&logoColor=white

[Chrome-url]: https://chrome.google.com/webstore/detail/chatgptbox/eobbhoofkanlmddnplfhnmkfbnlhpbbo

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

## News

- This extension does **not** collect your data. You can verify it by conducting a global search for `fetch(` and `XMLHttpRequest(` in the code to find all network request calls. The amount of code is not much, so it's easy to do that.

- This tool will not transmit any data to ChatGPT unless you explicitly ask it to. By default, the extension must be activated manually. It will only send a request to ChatGPT if you specifically click "Ask ChatGPT" or trigger the selection floating tools — and this is applicable only when you're using GPT API modes. (issue #407)

- You can use projects like https://github.com/BerriAI/litellm / https://github.com/songquanpeng/one-api to convert LLM APIs into OpenAI format and use them in conjunction with ChatGPTBox's `Custom Model` mode

- You can also use [Ollama](https://github.com/ChatGPTBox-dev/chatGPTBox/issues/616#issuecomment-1975186467) / https://openrouter.ai/docs#models with ChatGPTBox's `Custom Model` mode

## ✨ Features

- 🌈 Call up the chat dialog box on any page at any time. (<kbd>Ctrl</kbd>+<kbd>B</kbd>)
- 📱 Support for mobile devices.
- 📓 Summarize any page with right-click menu. (<kbd>Alt</kbd>+<kbd>B</kbd>)
- 📖 Independent conversation page. (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>)
- 🔗 Multiple API support (Web API for Free and Plus users, GPT-3.5, GPT-4, Claude, New Bing, Moonshot, Self-Hosted, Azure etc.).
- 📦 Integration for various commonly used websites (Reddit, Quora, YouTube, GitHub, GitLab, StackOverflow, Zhihu, Bilibili). (Inspired by [wimdenherder](https://github.com/wimdenherder))
- 🔍 Integration to all mainstream search engines, and custom queries to support additional sites.
- 🧰 Selection tool and right-click menu to perform various tasks, such as translation, summarization, polishing,
  sentiment analysis, paragraph division, code explain and queries.
- 🗂️ Static cards support floating chat boxes for multi-branch conversations.
- 🖨️ Easily save your complete chat records or copy them partially.
- 🎨 Powerful rendering support, whether for code highlighting or complex mathematical formulas.
- 🌍 Language preference support.
- 📝 Custom API address support.
- ⚙️ All site adaptations and selection tools(bubble) can be freely switched on or off, disable modules you don't need.
- 💡 Selection tools and site adaptation are easy to develop and extend, see the [Development&Contributing][dev-url]
  section.
- 😉 Chat to improve the answer quality.

## Preview

<div align="center">

**Search Engine Integration, Floating Windows, Conversation Branches**

![preview_google_floatingwindow_conversationbranch](screenshots/preview_google_floatingwindow_conversationbranch.jpg)

**Integration with Commonly Used Websites, Selection Tools**

![preview_reddit_selectiontools](screenshots/preview_reddit_selectiontools.jpg)

**Independent Conversation Page**

![preview_independentpanel](screenshots/preview_independentpanel.jpg)

**Git Analysis, Right Click Menu**

![preview_github_rightclickmenu](screenshots/preview_github_rightclickmenu.jpg)

**Video Summary**

![preview_youtube](screenshots/preview_youtube.jpg)

**Mobile Support**

![image](https://user-images.githubusercontent.com/13366013/225529110-9221c8ce-ad41-423e-b6ec-097981e74b66.png)

**Settings**

![preview_settings](screenshots/preview_settings.jpg)

</div>

## Credit

This project is based on one of my other repositories, [josStorer/chatGPT-search-engine-extension](https://github.com/josStorer/chatGPT-search-engine-extension)

[josStorer/chatGPT-search-engine-extension](https://github.com/josStorer/chatGPT-search-engine-extension) is forked
from [wong2/chat-gpt-google-extension](https://github.com/wong2/chat-gpt-google-extension) (I learned a lot from that)
and detached since 14 December of 2022

[wong2/chat-gpt-google-extension](https://github.com/wong2/chat-gpt-google-extension) is inspired
by [ZohaibAhmed/ChatGPT-Google](https://github.com/ZohaibAhmed/ChatGPT-Google) ([upstream-c54528b](https://github.com/wong2/chatgpt-google-extension/commit/c54528b0e13058ab78bfb433c92603db017d1b6b))
