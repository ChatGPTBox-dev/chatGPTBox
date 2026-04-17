import { JSDOM } from 'jsdom'
import fetch, { Headers } from 'node-fetch'

const config = {
  google: {
    inputQuery: ["input[name='q']", "textarea[name='q']"],
    sidebarContainerQuery: ['#rhs'],
    appendContainerQuery: ['#rcnt'],
    resultsContainerQuery: ['#rso'],
  },
  bing: {
    inputQuery: ["[name='q']"],
    sidebarContainerQuery: ['#b_context'],
    appendContainerQuery: [],
    resultsContainerQuery: ['#b_results'],
  },
  yahoo: {
    inputQuery: ["input[name='p']"],
    sidebarContainerQuery: ['#right', '.Contents__inner.Contents__inner--sub'],
    appendContainerQuery: ['#cols', '#contents__wrap'],
    resultsContainerQuery: [
      '#main-algo',
      '.searchCenterMiddle',
      '.Contents__inner.Contents__inner--main',
      '#contentsInner',
    ],
  },
  duckduckgo: {
    inputQuery: ["input[name='q']"],
    sidebarContainerQuery: ['.js-react-sidebar', '.react-results--sidebar'],
    appendContainerQuery: ['#links_wrapper'],
    resultsContainerQuery: ['.react-results--main'],
  },
  startpage: {
    inputQuery: ["input[name='query']"],
    sidebarContainerQuery: ['#sidebar'],
    appendContainerQuery: [],
    resultsContainerQuery: ['#main'],
  },
  baidu: {
    inputQuery: ["input[id='kw']"],
    sidebarContainerQuery: ['#content_right'],
    appendContainerQuery: ['#container'],
    resultsContainerQuery: ['#content_left', '#results'],
  },
  kagi: {
    inputQuery: ["input[name='q']", "textarea[name='q']"],
    sidebarContainerQuery: ['.right-content-box'],
    appendContainerQuery: ['#_0_app_content'],
    resultsContainerQuery: ['#main', '#app'],
  },
  yandex: {
    inputQuery: ["input[name='text']"],
    sidebarContainerQuery: ['#search-result-aside'],
    appendContainerQuery: [],
    resultsContainerQuery: ['#search-result'],
  },
  naver: {
    inputQuery: ["input[name='query']"],
    sidebarContainerQuery: ['#main_pack'],
    appendContainerQuery: ['#content'],
    resultsContainerQuery: ['#main_pack', '#ct'],
  },
  brave: {
    inputQuery: ["input[name='q']"],
    sidebarContainerQuery: ['.sidebar'],
    appendContainerQuery: [],
    resultsContainerQuery: ['#results'],
  },
  searx: {
    inputQuery: ["input[name='q']"],
    sidebarContainerQuery: ['#sidebar_results', '#sidebar'],
    appendContainerQuery: [],
    resultsContainerQuery: ['#urls', '#main_results', '#results'],
  },
  ecosia: {
    inputQuery: ["input[name='q']"],
    sidebarContainerQuery: ['.sidebar.web__sidebar'],
    appendContainerQuery: ['#main'],
    resultsContainerQuery: ['.mainline'],
  },
  neeva: {
    inputQuery: ["input[name='q']"],
    sidebarContainerQuery: ['.result-group-layout__stickyContainer-iDIO8'],
    appendContainerQuery: ['.search-index__searchHeaderContainer-2JD6q'],
    resultsContainerQuery: ['.result-group-layout__component-1jzTe', '#search'],
  },
}

const urls = {
  google: [
    /*'https://www.google.com/search?q=hello'*/
  ],
  bing: ['https://www.bing.com/search?q=hello'],
  yahoo: [
    /*'https://search.yahoo.com/search?p=hello', */ 'https://search.yahoo.co.jp/search?p=hello',
  ],
  duckduckgo: [],
  startpage: [], // need redirect and post https://www.startpage.com/do/search?query=hello
  baidu: ['https://www.baidu.com/s?wd=hello'],
  kagi: [], // need login https://kagi.com/search?q=hello
  yandex: [], // need cookie https://yandex.com/search/?text=hello
  naver: ['https://search.naver.com/search.naver?query=hello'],
  brave: [],
  searx: [
    /*'https://searx.tiekoetter.com/search?q=hello'*/
  ],
  ecosia: [], // unknown verify method https://www.ecosia.org/search?q=hello
  neeva: [], // unknown verify method(FetchError: maximum redirect reached) https://neeva.com/search?q=hello
  presearch: [],
}

const commonHeaders = {
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
  Connection: 'keep-alive',
  'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7', // for baidu
}

const desktopHeaders = new Headers({
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36 Edg/108.0.1462.76',
  ...commonHeaders,
})

const mobileHeaders = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Mobile Safari/537.36 Edg/108.0.1462.76',
  ...commonHeaders,
}

const desktopQueryNames = [
  'inputQuery',
  'sidebarContainerQuery',
  'appendContainerQuery',
  'resultsContainerQuery',
]

const mobileQueryNames = ['inputQuery', 'resultsContainerQuery']

let errors = ''

async function verify(errorTag, urls, headers, queryNames) {
  await Promise.all(
    Object.entries(urls).map(([siteName, urlArray]) =>
      Promise.all(
        urlArray.map((url) =>
          fetch(url, {
            method: 'GET',
            headers: headers,
          })
            .then((response) => response.text())
            .then((text) => {
              const dom = new JSDOM(text)
              for (const queryName of queryNames) {
                const queryArray = config[siteName][queryName]
                if (queryArray.length === 0) continue

                let foundQuery
                for (const query of queryArray) {
                  const element = dom.window.document.querySelector(query)
                  if (element) {
                    foundQuery = query
                    break
                  }
                }
                if (foundQuery) {
                  console.log(`${siteName} ${url} ${queryName}: ${foundQuery} passed`)
                } else {
                  const error = `${siteName} ${url} ${queryName} failed`
                  errors += errorTag + error + '\n'
                }
              }
            })
            .catch((error) => {
              errors += errorTag + error + '\n'
            }),
        ),
      ),
    ),
  )
}

async function main() {
  console.log('Verify desktop search engine configs:')
  await verify('desktop: ', urls, desktopHeaders, desktopQueryNames)
  console.log('\nVerify mobile search engine configs:')
  await verify('mobile: ', urls, mobileHeaders, mobileQueryNames)

  if (errors.length > 0) throw new Error('\n' + errors)
  else console.log('\nAll passed')
}

main()
