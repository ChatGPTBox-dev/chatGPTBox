Long time no see — ChatGPTBox is back! Nearly every feature that had broken due to page updates or API changes has been fixed, and we’ve also introduced some new features.

Over the past year the LLM landscape has shifted dramatically, and the key players are now fairly clear. Regarding ChatGPTBox’s free web APIs, some providers are still actively trying to block reverse-engineering, while others remain open. At the moment, ChatGPT, Claude, and Kimi are still open, so we’ll keep maintaining the related web free APIs. The web APIs for Bing and Gemini, however, will no longer be supported; if you need some reverse-engineering web apis, please check out the work of this organization: https://github.com/LLM-Red-Team.

As OpenRouter has consistently offered stable and affordable APIs, we’ve now added direct option support for it — no need to rely on custom mode and manually fill in the API URL.

During this period, countless AI projects have exploded onto the scene and just as many have quietly disappeared. I’ve been tied up with various non-public projects and have neglected ChatGPTBox, while also pondering how to keep it vibrant.

I have to admit that when ChatGPTBox was first created, many decisions and code designs were rather hasty and not very modern. Without much forethought, I made choices that now make it inconvenient to add new features.

I’m currently rewriting ChatGPTBox from scratch using the WXT framework while ensuring full backward compatibility with old data. This will take a considerable amount of time, but I’ll keep pushing forward. I also have some commercialization ideas for ChatGPTBox; of course only server-related features would be charged, while all web APIs and user Api Key features will remain completely free, and the project will stay open-source under the MIT license.

As I’m simultaneously in charge of several other non-public projects, I can’t promise when the rewrite will be finished, but I’ll keep making steady progress. In the meantime, I’ll continue to fix major issues in the current version of ChatGPTBox.

## Changes

### Features

- add support for openRouter, AI/ML and DeepSeek api (previously required filling in the URL via the custom model option)
- a new option has been added to the general settings to disable cropText, ensuring the full input tokens are always passed. This can improve summarization on sites like YouTube, but note that you should only disable cropText when using a model with a sufficiently long context.
- <img width="300" src="https://github.com/user-attachments/assets/455931d6-8a73-4cdf-88a6-d4dcff53ecd7"/>
- reasoning model renderer support
- <img width="420" src="https://github.com/user-attachments/assets/1951cc7e-d12a-4cc2-8f7f-826603bbf884" />

### Improvements
- add a range of new models recently made available by various AI providers
- significantly improve the prompt templates for built-in tools. Great thanks to @PeterDaveHello 
- update and enhance API clients (including Claude, ChatGLM, and Kimi.Moonshot) that had become unavailable or unstable due to recent policy changes and adjustments by AI providers
- increase the default input and response limits, as current LLMs generally support longer contexts
- improve kimi.moonshot support and add more available models like k2, kimi-latest, k1.5, k1.5-thinking
- improve google search sidebar

### Fixes
- fix the issue where YouTube subtitles could not be fetched and the video summarization feature became unavailable due to the recent introduction of the "pot" parameter by YouTube
- avoid crash when readability parser returns null (#865) @PeterDaveHello 
- fix the issue where kimi web functionality became unstable due to changes in the page and domain
- fix an issue where the selected model might be not displayed correctly due to inconsistent key ordering in JSON.stringify
- fix the issue of abnormal subtitle retrieval caused by changes to Bilibili API

### Chores
- update adapters support for startpage, kagi, naver, wechat, juejin
- update dependencies to mitigate security vulnerabilities @PeterDaveHello 
- update default configs
- since ChatGPT has relaxed the web API request restrictions, it is no longer necessary to simulate input to retrieve data (#869)
- update verify-search-engine-configs.mjs
