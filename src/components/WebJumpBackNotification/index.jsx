import { useTranslation } from 'react-i18next'
import PropTypes from 'prop-types'
import Browser from 'webextension-polyfill'
import { toast, ToastContainer } from 'react-toastify'
import { useEffect } from 'react'
import 'react-toastify/dist/ReactToastify.css'
import { useTheme } from '../../hooks/use-theme.mjs'
import { getUserConfig } from '../../config/index.mjs'

const WebJumpBackNotification = (props) => {
  const { t } = useTranslation()
  const [theme, config] = useTheme()

  const buttonStyle = {
    padding: '0 8px',
    border: '1px solid',
    borderRadius: '4px',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    color: 'inherit',
    backgroundColor: 'transparent',
  }

  useEffect(() => {
    toast(
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: '4px',
          justifyContent: 'space-between',
        }}
      >
        <div>
          {props.chatgptMode
            ? t('Please keep this tab open. You can now use the web mode of ChatGPTBox')
            : t('You have successfully logged in for ChatGPTBox and can now return')}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {props.chatgptMode && (
            <button
              style={buttonStyle}
              onClick={() => {
                Browser.runtime.sendMessage({
                  type: 'PIN_TAB',
                  data: {
                    saveAsChatgptConfig: true,
                  },
                })
              }}
            >
              {t('Pin Tab')}
            </button>
          )}
          <button
            style={buttonStyle}
            onClick={async () => {
              Browser.runtime.sendMessage({
                type: 'ACTIVATE_URL',
                data: {
                  tabId: (await getUserConfig()).notificationJumpBackTabId,
                },
              })
            }}
          >
            {t('Go Back')}
          </button>
        </div>
      </div>,
      {
        toastId: 0,
        updateId: 0,
      },
    )
  }, [config.themeMode, config.preferredLanguage])

  return (
    <ToastContainer
      style={{
        width: '440px',
      }}
      position="top-center"
      autoClose={7000}
      newestOnTop={false}
      closeOnClick={false}
      rtl={false}
      pauseOnFocusLoss={true}
      draggable={false}
      theme={theme}
    />
  )
}

WebJumpBackNotification.propTypes = {
  container: PropTypes.object.isRequired,
  chatgptMode: PropTypes.bool,
}

export default WebJumpBackNotification
