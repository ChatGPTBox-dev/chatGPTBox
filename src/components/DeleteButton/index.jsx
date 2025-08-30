import { useEffect, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import { useTranslation } from 'react-i18next'
import { TrashIcon } from '@primer/octicons-react'

DeleteButton.propTypes = {
  onConfirm: PropTypes.func.isRequired,
  size: PropTypes.number.isRequired,
  text: PropTypes.string.isRequired,
}

function DeleteButton({ onConfirm, size, text }) {
  const { t } = useTranslation()
  const [waitConfirm, setWaitConfirm] = useState(false)
  const confirmRef = useRef(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (waitConfirm) confirmRef.current.focus()
  }, [waitConfirm])

  return (
    <span>
      <button
        ref={confirmRef}
        type="button"
        className="normal-button"
        style={{
          fontSize: '10px',
          ...(waitConfirm ? {} : { display: 'none' }),
        }}
        disabled={confirming}
        aria-busy={confirming ? 'true' : 'false'}
        onMouseDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
        onBlur={() => {
          if (!confirming) setWaitConfirm(false)
        }}
        onClick={async (e) => {
          if (confirming) return
          e.preventDefault()
          e.stopPropagation()
          setConfirming(true)
          try {
            await onConfirm()
            setWaitConfirm(false)
          } catch (err) {
            // Keep confirmation visible to allow retry; optionally log
            // eslint-disable-next-line no-console
            console.error(err)
          } finally {
            setConfirming(false)
          }
        }}
      >
        {t('Confirm')}
      </button>
      <span
        title={text}
        className="gpt-util-icon"
        role="button"
        tabIndex={0}
        aria-label={text}
        aria-hidden={waitConfirm ? 'true' : undefined}
        style={waitConfirm ? { visibility: 'hidden' } : {}}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            setWaitConfirm(true)
          }
        }}
        onClick={(e) => {
          e.stopPropagation()
          setWaitConfirm(true)
        }}
      >
        <TrashIcon size={size} />
      </span>
    </span>
  )
}

export default DeleteButton
