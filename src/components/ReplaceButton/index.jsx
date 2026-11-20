import { useEffect, useRef, useState } from 'react'
import { CheckIcon, ReplyIcon, XIcon } from '@primer/octicons-react'
import PropTypes from 'prop-types'
import { useTranslation } from 'react-i18next'

ReplaceButton.propTypes = {
  onReplace: PropTypes.func.isRequired,
  size: PropTypes.number.isRequired,
  className: PropTypes.string,
}

function ReplaceButton({ className, onReplace, size }) {
  const { t } = useTranslation()
  const [status, setStatus] = useState('idle')
  const timeoutRef = useRef(null)

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  const onClick = () => {
    setStatus(onReplace() ? 'replaced' : 'failed')
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      setStatus('idle')
      timeoutRef.current = null
    }, 800)
  }

  return (
    <span
      title={status === 'failed' ? t('Replace Failed') : t('Replace Selection')}
      className={`gpt-util-icon ${className ? className : ''}`}
      onClick={onClick}
    >
      {status === 'replaced' ? (
        <CheckIcon size={size} />
      ) : status === 'failed' ? (
        <XIcon size={size} />
      ) : (
        <ReplyIcon size={size} />
      )}
    </span>
  )
}

export default ReplaceButton
