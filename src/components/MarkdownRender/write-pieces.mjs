/**
 * HyperMarkdown's streaming parser mishandles a table when a large block of markdown arrives in
 * a single write: the table loses its header row and swallows the block above it, and a thematic
 * break that follows it disappears. The same text written in small pieces -- the size a token
 * stream arrives in -- renders correctly, so every write is split here.
 *
 * Measured against `@aeven-ai/hypermarkdown@0.4.4` with `Intro. / table / Outro. / ---`: pieces
 * of at most 8 characters keep both the header row and the rule, pieces of 16-32 keep the header
 * but lose the rule, and one write loses both. A document without a table is unaffected either
 * way, and reference links and code fences resolve at every size.
 */
const MAX_PIECE_LENGTH = 8

/**
 * Hand markdown to a renderer the way its parser expects to receive it.
 * @param {{ write: (text: string, finalize: boolean) => void }} renderer
 * @param {string} text the new markdown
 * @param {boolean} finalize whether this is the end of the stream
 */
export function writeInPieces(renderer, text, finalize) {
  if (text.length <= MAX_PIECE_LENGTH) {
    renderer.write(text, finalize)
    return
  }
  for (let start = 0; start < text.length; start += MAX_PIECE_LENGTH) {
    const end = Math.min(start + MAX_PIECE_LENGTH, text.length)
    renderer.write(text.slice(start, end), finalize && end === text.length)
  }
}
