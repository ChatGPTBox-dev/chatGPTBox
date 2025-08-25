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
        onMouseDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
        onBlur={() => {
          setWaitConfirm(false)
        }}
        onClick={(e) => {
          e.stopPropagation()
          setWaitConfirm(false)
          onConfirm()
        }}
      >
        {t('Confirm')}
      </button>
      <span
        title={text}
        className="gpt-util-icon"
        style={waitConfirm ? { display: 'none' } : {}}
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
