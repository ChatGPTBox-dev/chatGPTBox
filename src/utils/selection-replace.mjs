// Capture the editable target of the current selection so its content can be
// replaced later (e.g. with a polished or translated answer), even after the
// selection itself has been lost by interacting with the floating toolbar.
// Only editable targets (text fields and contenteditable regions) are
// supported; static page content is intentionally left untouched.

const TEXT_FIELD_INPUT_TYPES = ['text', 'search', 'url', 'tel']

const isTextField = (element) => {
  if (!element || typeof element.tagName !== 'string') return false
  if (element.readOnly || element.disabled) return false
  const tagName = element.tagName.toUpperCase()
  if (tagName === 'TEXTAREA') return true
  if (tagName !== 'INPUT') return false
  return TEXT_FIELD_INPUT_TYPES.includes((element.type || 'text').toLowerCase())
}

// walk up to the editing host: focus() only works on the top-most
// contenteditable element, not on child elements of the region
const findContentEditableElement = (node) => {
  if (!node) return null
  let element = node.nodeType === 3 ? node.parentElement : node
  if (!element || !element.isContentEditable) return null
  while (element.parentElement && element.parentElement.isContentEditable) {
    element = element.parentElement
  }
  return element
}

/**
 * Capture the editable target of the current selection.
 * @param {Document} doc
 * @returns {object|null} an opaque descriptor for replaceCapturedSelection, or null
 *   if the selection is not inside an editable element
 */
export const captureEditableSelection = (doc = globalThis.document) => {
  if (!doc) return null
  try {
    const activeElement = doc.activeElement
    if (isTextField(activeElement)) {
      const { selectionStart: start, selectionEnd: end } = activeElement
      if (typeof start !== 'number' || typeof end !== 'number' || start >= end) return null
      return {
        kind: 'text-field',
        element: activeElement,
        start,
        end,
        text: activeElement.value.slice(start, end),
        // the full value is kept so edits elsewhere in the field (which may
        // shift the selection offsets) reliably invalidate the capture
        fieldValue: activeElement.value,
      }
    }

    const selection = typeof doc.getSelection === 'function' ? doc.getSelection() : null
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
    const range = selection.getRangeAt(0)
    const element = findContentEditableElement(range.commonAncestorContainer)
    if (!element) return null
    return {
      kind: 'contenteditable',
      element,
      range: range.cloneRange(),
      text: range.toString(),
    }
  } catch (error) {
    console.error('[selection-replace] Failed to capture selection:', error)
    return null
  }
}

const dispatchInputEvent = (element) => {
  if (typeof element.dispatchEvent !== 'function') return
  const event = globalThis.InputEvent
    ? new globalThis.InputEvent('input', { bubbles: true, inputType: 'insertText' })
    : globalThis.Event
    ? new globalThis.Event('input', { bubbles: true })
    : null
  if (event) element.dispatchEvent(event)
}

// Set value through the prototype setter so pages using controlled inputs
// (e.g. React) observe the change when the input event is dispatched.
const setNativeValue = (element, value) => {
  let descriptor
  let proto = Object.getPrototypeOf(element)
  while (proto && !descriptor) {
    descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
    proto = Object.getPrototypeOf(proto)
  }
  if (descriptor && descriptor.set) descriptor.set.call(element, value)
  else element.value = value
}

// single-line inputs drop line breaks from their value, so they become spaces the
// way browsers insert them into such fields (trailing line breaks are dropped)
const toSingleLine = (text) => text.replace(/(\r\n|\r|\n)+$/, '').replace(/\r\n|\r|\n/g, ' ')

const replaceInTextField = (captured, text, doc) => {
  const { element, start, end, fieldValue: value } = captured
  // the field must still qualify for capture, e.g. not have become a password field
  const isUnchanged = () =>
    element.isConnected !== false && isTextField(element) && (element.value ?? '') === value
  if (!isUnchanged()) return false
  const insertedText = element.tagName.toUpperCase() === 'INPUT' ? toSingleLine(text) : text
  const replacedValue = value.slice(0, start) + insertedText + value.slice(end)

  if (typeof element.focus === 'function') element.focus()
  // focus handlers of the page may have changed the field or moved the focus away,
  // and execCommand edits whichever element has the focus
  if (!isUnchanged() || doc.activeElement !== element) return false
  if (typeof element.setSelectionRange === 'function' && typeof doc.execCommand === 'function') {
    element.setSelectionRange(start, end)
    try {
      // execCommand keeps the native undo history working where supported
      doc.execCommand('insertText', false, insertedText)
    } catch (error) {
      // fall back to setting the value below
    }
  }
  if (element.value !== replacedValue) {
    // page handlers may have changed the field during the command; their edits are
    // kept instead of being overwritten with a value built from the old capture
    if (element.value !== value) return false
    setNativeValue(element, replacedValue)
    dispatchInputEvent(element)
  }
  if (typeof element.setSelectionRange === 'function') {
    const caretPosition = start + insertedText.length
    element.setSelectionRange(caretPosition, caretPosition)
  }
  return true
}

// a single text node would render line breaks as spaces in a normal-whitespace
// editing host, so they become <br> elements (the text is never parsed as HTML)
const createTextContent = (text, doc) => {
  const lines = text.split(/\r?\n/)
  if (lines.length === 1) return doc.createTextNode(text)
  const fragment = doc.createDocumentFragment()
  lines.forEach((line, index) => {
    if (index > 0) fragment.appendChild(doc.createElement('br'))
    if (line) fragment.appendChild(doc.createTextNode(line))
  })
  return fragment
}

const replaceInContentEditable = (captured, text, doc) => {
  const { element, range, text: originalText } = captured
  // re-resolving the editing host catches parts of the region that were made
  // non-editable since capture, which the manual fallback could overwrite otherwise
  const isUnchanged = () =>
    element.isConnected !== false &&
    element.isContentEditable &&
    findContentEditableElement(range.commonAncestorContainer) === element &&
    range.toString() === originalText
  if (!isUnchanged()) return false

  if (typeof element.focus === 'function') element.focus()
  // focus handlers of the page may have changed the content in the meantime
  if (!isUnchanged()) return false
  const selection = typeof doc.getSelection === 'function' ? doc.getSelection() : null
  if (selection) {
    selection.removeAllRanges()
    selection.addRange(range)
    if (typeof doc.execCommand === 'function') {
      try {
        // as for text fields, only trust execCommand when the captured text was
        // actually replaced (the live range no longer holds it): editors may
        // cancel the edit while the command reports success
        if (
          doc.execCommand('insertText', false, text) &&
          (range.toString() !== originalText || text === originalText)
        ) {
          return true
        }
      } catch (error) {
        // fall through to manual replacement
      }
    }
  }
  range.deleteContents()
  range.insertNode(createTextContent(text, doc))
  range.collapse(false)
  if (selection) {
    // re-apply the collapsed range so the cursor ends up after the inserted text
    selection.removeAllRanges()
    selection.addRange(range)
  }
  dispatchInputEvent(element)
  return true
}

/**
 * Replace the previously captured selection with the given plain text.
 * The original content is verified first so stale captures never overwrite
 * content that has changed in the meantime.
 * @param {object|null} captured descriptor from captureEditableSelection
 * @param {string} text plain text to insert (never parsed as HTML)
 * @param {Document} doc
 * @returns {boolean} whether the replacement was performed
 */
export const replaceCapturedSelection = (captured, text, doc = globalThis.document) => {
  if (!captured || typeof text !== 'string' || !doc) return false
  try {
    if (captured.kind === 'text-field') return replaceInTextField(captured, text, doc)
    if (captured.kind === 'contenteditable') return replaceInContentEditable(captured, text, doc)
  } catch (error) {
    console.error('[selection-replace] Failed to replace selection:', error)
  }
  return false
}
