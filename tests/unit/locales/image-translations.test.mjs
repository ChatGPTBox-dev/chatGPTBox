import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

const localeRoot = new URL('../../../src/_locales/', import.meta.url)

const imageMessageKeys = Object.freeze([
  'Images require an OpenAI-compatible vision API.',
  'Choose a model that supports image input.',
  'Attach images',
  'Drop images here or paste a screenshot',
  'Attached images',
  'Image',
  'Reading image',
  'Remove image',
  'Images must be PNG, JPEG, WEBP, or GIF.',
  'Each image must be 4 MiB or smaller.',
  'You can attach up to 4 images.',
  'Total image size must be 12 MiB or smaller.',
  'This file is not a supported image.',
  'Unable to read image.',
  'Unable to send images.',
  'Describe these images',
])

test('every locale defines the image attachment messages', async () => {
  const localeDirectories = (await readdir(localeRoot, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  )

  for (const localeDirectory of localeDirectories) {
    const messages = JSON.parse(
      await readFile(new URL(`${localeDirectory.name}/main.json`, localeRoot), 'utf8'),
    )

    for (const key of imageMessageKeys) {
      assert.equal(
        typeof messages[key],
        'string',
        `${localeDirectory.name} is missing ${JSON.stringify(key)}`,
      )
      assert.notEqual(messages[key].trim(), '', `${localeDirectory.name} has an empty ${key}`)
    }
  }
})
