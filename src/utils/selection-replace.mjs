// Capture the editable target of the current selection so its content can be
// replaced later (e.g. with a polished or translated answer), even after the
// selection itself has been lost by interacting with the floating toolbar.
// Only editable targets (text fields and contenteditable regions) are
// supported; static page content is intentionally left untouched.

const TEXT_FIELD_INPUT_TYPES = ['text', 'search', 'url', 'tel', 'password']

const isTextField = (element) => {
  if (!element || typeof element.tagName !== 'string') return false
  const tagName = element.tagName.toUpperCase()
  if (tagName === 'TEXTAREA') return true
  if (tagName !== 'INPUT') return false
  return TEXT_FIELD_INPUT_TYPES.includes((element.type || 'text').toLowerCase())
}

const findContentEditableElement = (node) => {
  if (!node) return null
  const element = node.nodeType === 3 ? node.parentElement : node
  return element && element.isContentEditable ? element : null
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
  const InputEventConstructor = globalThis.InputEvent
  const event = InputEventConstructor
    ? new InputEventConstructor('input', { bubbles: true, inputType: 'insertText' })
    : { type: 'input', bubbles: true }
  element.dispatchEvent(event)
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

const replaceInTextField = (captured, text, doc) => {
  const { element, start, end, text: originalText } = captured
  if (element.isConnected === false) return false
  const value = element.value ?? ''
  if (value.slice(start, end) !== originalText) return false

  if (typeof element.focus === 'function') element.focus()
  let replaced = false
  if (typeof element.setSelectionRange === 'function' && typeof doc.execCommand === 'function') {
    element.setSelectionRange(start, end)
    try {
      // execCommand keeps the native undo history working where supported
      replaced = doc.execCommand('insertText', false, text) && element.value !== value
    } catch (error) {
      replaced = false
    }
    if (text === originalText) replaced = true
  }
  if (!replaced) {
    setNativeValue(element, value.slice(0, start) + text + value.slice(end))
    dispatchInputEvent(element)
  }
  if (typeof element.setSelectionRange === 'function') {
    const caretPosition = start + text.length
    element.setSelectionRange(caretPosition, caretPosition)
  }
  return true
}

const replaceInContentEditable = (captured, text, doc) => {
  const { element, range, text: originalText } = captured
  if (element.isConnected === false || !element.isContentEditable) return false
  if (range.toString() !== originalText) return false

  if (typeof element.focus === 'function') element.focus()
  const selection = typeof doc.getSelection === 'function' ? doc.getSelection() : null
  if (selection) {
    selection.removeAllRanges()
    selection.addRange(range)
    if (typeof doc.execCommand === 'function') {
      try {
        if (doc.execCommand('insertText', false, text)) return true
      } catch (error) {
        // fall through to manual replacement
      }
    }
  }
  range.deleteContents()
  range.insertNode(doc.createTextNode(text))
  range.collapse(false)
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
