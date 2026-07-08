import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import {
  captureEditableSelection,
  replaceCapturedSelection,
} from '../../../src/utils/selection-replace.mjs'

const createTextField = ({ tagName = 'TEXTAREA', type, value = '', start = 0, end = 0 } = {}) => {
  const element = {
    tagName,
    value,
    selectionStart: start,
    selectionEnd: end,
    isConnected: true,
    focused: false,
    dispatchedEvents: [],
    focus() {
      this.focused = true
    },
    setSelectionRange(newStart, newEnd) {
      this.selectionStart = newStart
      this.selectionEnd = newEnd
    },
    dispatchEvent(event) {
      this.dispatchedEvents.push(event)
      return true
    },
  }
  if (type) element.type = type
  return element
}

const createContentEditableElement = () => ({
  nodeType: 1,
  isContentEditable: true,
  isConnected: true,
  parentElement: null,
  dispatchedEvents: [],
  focus() {
    this.focused = true
  },
  dispatchEvent(event) {
    this.dispatchedEvents.push(event)
    return true
  },
})

const createRange = (element, text) => ({
  commonAncestorContainer: element,
  collapsed: text.length === 0,
  deletedContents: false,
  insertedNodes: [],
  toString() {
    return text
  },
  cloneRange() {
    return this
  },
  deleteContents() {
    this.deletedContents = true
  },
  insertNode(node) {
    this.insertedNodes.push(node)
  },
  collapse() {},
})

const createDocument = ({ activeElement = null, selection = null, execCommand } = {}) => {
  const doc = {
    activeElement,
    createTextNode(text) {
      return { nodeType: 3, textContent: text }
    },
    getSelection() {
      return selection
    },
  }
  if (execCommand) doc.execCommand = execCommand
  return doc
}

const createSelection = (range) => ({
  rangeCount: range ? 1 : 0,
  isCollapsed: range ? range.collapsed : true,
  ranges: [],
  getRangeAt() {
    return range
  },
  removeAllRanges() {
    this.ranges = []
  },
  addRange(newRange) {
    this.ranges.push(newRange)
  },
})

beforeEach(() => {
  delete globalThis.InputEvent
})

test('captureEditableSelection returns null without a document', () => {
  assert.equal(captureEditableSelection(null), null)
})

test('captureEditableSelection captures a textarea selection', () => {
  const element = createTextField({ value: 'hello world', start: 6, end: 11 })
  const doc = createDocument({ activeElement: element })

  const captured = captureEditableSelection(doc)

  assert.equal(captured.kind, 'text-field')
  assert.equal(captured.element, element)
  assert.equal(captured.start, 6)
  assert.equal(captured.end, 11)
  assert.equal(captured.text, 'world')
})

test('captureEditableSelection captures a text input selection', () => {
  const element = createTextField({
    tagName: 'INPUT',
    type: 'text',
    value: 'abcdef',
    start: 0,
    end: 3,
  })
  const doc = createDocument({ activeElement: element })

  const captured = captureEditableSelection(doc)

  assert.equal(captured.kind, 'text-field')
  assert.equal(captured.text, 'abc')
})

test('captureEditableSelection ignores inputs without selection support', () => {
  const element = createTextField({
    tagName: 'INPUT',
    type: 'checkbox',
    value: 'on',
    start: 0,
    end: 2,
  })
  const doc = createDocument({ activeElement: element })

  assert.equal(captureEditableSelection(doc), null)
})

test('captureEditableSelection ignores collapsed text field selections', () => {
  const element = createTextField({ value: 'hello', start: 2, end: 2 })
  const doc = createDocument({ activeElement: element })

  assert.equal(captureEditableSelection(doc), null)
})

test('captureEditableSelection captures a contenteditable selection', () => {
  const element = createContentEditableElement()
  const range = createRange(element, 'selected text')
  const doc = createDocument({ selection: createSelection(range) })

  const captured = captureEditableSelection(doc)

  assert.equal(captured.kind, 'contenteditable')
  assert.equal(captured.element, element)
  assert.equal(captured.text, 'selected text')
})

test('captureEditableSelection resolves text nodes to their parent element', () => {
  const element = createContentEditableElement()
  const textNode = { nodeType: 3, parentElement: element }
  const range = createRange(textNode, 'selected text')
  const doc = createDocument({ selection: createSelection(range) })

  const captured = captureEditableSelection(doc)

  assert.equal(captured.kind, 'contenteditable')
  assert.equal(captured.element, element)
})

test('captureEditableSelection returns null for non-editable selections', () => {
  const element = { nodeType: 1, isContentEditable: false }
  const range = createRange(element, 'selected text')
  const doc = createDocument({ selection: createSelection(range) })

  assert.equal(captureEditableSelection(doc), null)
})

test('captureEditableSelection returns null for collapsed selections', () => {
  const element = createContentEditableElement()
  const range = createRange(element, '')
  const doc = createDocument({ selection: createSelection(range) })

  assert.equal(captureEditableSelection(doc), null)
})

test('replaceCapturedSelection rejects invalid arguments', () => {
  assert.equal(replaceCapturedSelection(null, 'text', createDocument()), false)
  const element = createTextField({ value: 'hello', start: 0, end: 5 })
  const doc = createDocument({ activeElement: element })
  const captured = captureEditableSelection(doc)
  assert.equal(replaceCapturedSelection(captured, undefined, doc), false)
})

test('replaceCapturedSelection replaces text field content and dispatches input', () => {
  const element = createTextField({ value: 'say helo world', start: 4, end: 8 })
  const doc = createDocument({ activeElement: element })
  const captured = captureEditableSelection(doc)

  const replaced = replaceCapturedSelection(captured, 'hello', doc)

  assert.equal(replaced, true)
  assert.equal(element.value, 'say hello world')
  assert.equal(element.focused, true)
  assert.equal(element.dispatchedEvents.length, 1)
  assert.equal(element.dispatchedEvents[0].type, 'input')
  assert.equal(element.selectionStart, 'say hello'.length)
  assert.equal(element.selectionEnd, 'say hello'.length)
})

test('replaceCapturedSelection uses execCommand when available', () => {
  const element = createTextField({ value: 'helo', start: 0, end: 4 })
  const doc = createDocument({
    activeElement: element,
    execCommand: (command, showUI, text) => {
      assert.equal(command, 'insertText')
      element.value = text
      return true
    },
  })
  const captured = captureEditableSelection(doc)

  const replaced = replaceCapturedSelection(captured, 'hello', doc)

  assert.equal(replaced, true)
  assert.equal(element.value, 'hello')
  assert.equal(element.dispatchedEvents.length, 0)
})

test('replaceCapturedSelection falls back when execCommand fails', () => {
  const element = createTextField({ value: 'helo', start: 0, end: 4 })
  const doc = createDocument({
    activeElement: element,
    execCommand: () => false,
  })
  const captured = captureEditableSelection(doc)

  const replaced = replaceCapturedSelection(captured, 'hello', doc)

  assert.equal(replaced, true)
  assert.equal(element.value, 'hello')
  assert.equal(element.dispatchedEvents.length, 1)
})

test('replaceCapturedSelection refuses stale text field content', () => {
  const element = createTextField({ value: 'hello world', start: 0, end: 5 })
  const doc = createDocument({ activeElement: element })
  const captured = captureEditableSelection(doc)
  element.value = 'changed content'

  assert.equal(replaceCapturedSelection(captured, 'hi', doc), false)
  assert.equal(element.value, 'changed content')
})

test('replaceCapturedSelection refuses disconnected text fields', () => {
  const element = createTextField({ value: 'hello', start: 0, end: 5 })
  const doc = createDocument({ activeElement: element })
  const captured = captureEditableSelection(doc)
  element.isConnected = false

  assert.equal(replaceCapturedSelection(captured, 'hi', doc), false)
})

test('replaceCapturedSelection replaces contenteditable content via range fallback', () => {
  const element = createContentEditableElement()
  const range = createRange(element, 'old text')
  const selection = createSelection(range)
  const doc = createDocument({ selection })
  const captured = captureEditableSelection(doc)

  const replaced = replaceCapturedSelection(captured, 'new text', doc)

  assert.equal(replaced, true)
  assert.equal(range.deletedContents, true)
  assert.equal(range.insertedNodes.length, 1)
  assert.equal(range.insertedNodes[0].textContent, 'new text')
  assert.equal(element.dispatchedEvents.length, 1)
  assert.equal(element.dispatchedEvents[0].type, 'input')
})

test('replaceCapturedSelection uses execCommand for contenteditable when available', () => {
  const element = createContentEditableElement()
  const range = createRange(element, 'old text')
  const selection = createSelection(range)
  let inserted = null
  const doc = createDocument({
    selection,
    execCommand: (command, showUI, text) => {
      inserted = text
      return true
    },
  })
  const captured = captureEditableSelection(doc)

  const replaced = replaceCapturedSelection(captured, 'new text', doc)

  assert.equal(replaced, true)
  assert.equal(inserted, 'new text')
  assert.equal(range.deletedContents, false)
  assert.deepEqual(selection.ranges, [range])
})

test('replaceCapturedSelection refuses stale contenteditable ranges', () => {
  const element = createContentEditableElement()
  const range = createRange(element, 'old text')
  const doc = createDocument({ selection: createSelection(range) })
  const captured = captureEditableSelection(doc)
  range.toString = () => 'mutated text'

  assert.equal(replaceCapturedSelection(captured, 'new text', doc), false)
  assert.equal(range.deletedContents, false)
})

test('replaceCapturedSelection refuses disconnected contenteditable elements', () => {
  const element = createContentEditableElement()
  const range = createRange(element, 'old text')
  const doc = createDocument({ selection: createSelection(range) })
  const captured = captureEditableSelection(doc)
  element.isConnected = false

  assert.equal(replaceCapturedSelection(captured, 'new text', doc), false)
})
