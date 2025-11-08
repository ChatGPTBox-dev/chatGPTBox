import {
  CardHeading,
  CardList,
  EmojiSmile,
  Palette,
  QuestionCircle,
  Translate,
  Braces,
  Globe,
  ChatText,
} from 'react-bootstrap-icons'
import { getPreferredLanguage } from '../../config/language.mjs'

const createGenPrompt =
  ({
    message = '',
    isTranslation = false,
    targetLanguage = '',
    enableBidirectional = false,
    includeLanguagePrefix = false,
  }) =>
  async (selection) => {
    let preferredLanguage = targetLanguage

    if (!preferredLanguage) {
      preferredLanguage = await getPreferredLanguage()
    }

    let fullMessage = isTranslation
      ? `You are a professional translator. Translate the following text into ${preferredLanguage}, preserving meaning, tone, and formatting. Only provide the translated result.`
      : message
    if (enableBidirectional) {
      fullMessage += ` If the text is already in ${preferredLanguage}, translate it into English instead following the same requirements. Only provide the translated result.`
    }
    const prefix = includeLanguagePrefix ? `Reply in ${preferredLanguage}.` : ''
    return `${prefix}${fullMessage}:\n'''\n${selection}\n'''`
  }

export const config = {
  explain: {
    icon: <ChatText />,
    label: 'Explain',
    genPrompt: async (selection) => {
      const preferredLanguage = await getPreferredLanguage()
      return `## Role
<role>
You are an expert teacher specializing in breaking down complex topics into easily understandable explanations.
</role>

## Task
<task>
Explain the selected content using simple, clear language suitable for someone encountering this topic for the first time.
</task>

## Instructions
<instructions>
1. **Read and understand**: Analyze the selected content thoroughly
2. **Identify complexity level**: Determine technical depth and adjust explanation accordingly
3. **Break down concepts**: Divide complex ideas into digestible parts
4. **Use analogies**: Employ relevant real-world comparisons when helpful
5. **Highlight key points**: Emphasize the most important takeaways
6. **Define jargon**: Explain any technical terms in plain language
7. **Provide context**: Explain why this information matters or how it's used
8. **Response language**: Reply in ${preferredLanguage}
</instructions>

## Output Format
<output_format>
## Simple Explanation
[Main concept explained in 2-3 sentences using everyday language]

## Key Points
- **Point 1**: [Important concept with brief explanation]
- **Point 2**: [Another key concept]
- **Point 3**: [Additional important information]

## In Detail
[Thorough explanation broken into logical sections]

### [Concept 1]
[Detailed explanation with examples if needed]

### [Concept 2]
[Detailed explanation with examples if needed]

## Why This Matters
[Practical relevance or context for understanding]
</output_format>

## Input Data
<input_data>
Selected Content:
${selection}
</input_data>

## Constraints
<constraints>
- Use simple, jargon-free language (or define technical terms)
- Avoid assuming prior knowledge
- Focus on clarity over completeness
- Use examples and analogies to aid understanding
- Keep explanation concise but thorough
</constraints>`
    },
  },
  translate: {
    icon: <Translate />,
    label: 'Translate',
    genPrompt: async (selection) => {
      const preferredLanguage = await getPreferredLanguage()
      return `## Role
<role>
You are a professional translator with expertise in maintaining semantic accuracy, cultural nuance, and stylistic tone across languages.
</role>

## Task
<task>
Translate the selected text into ${preferredLanguage} while preserving the original meaning, tone, style, and formatting.
</task>

## Instructions
<instructions>
1. **Analyze source text**:
   - Identify tone (formal, casual, technical, creative)
   - Note any idioms, cultural references, or wordplay
   - Recognize formatting elements (lists, emphasis, structure)

2. **Translate accurately**:
   - Preserve semantic meaning precisely
   - Maintain original tone and style
   - Adapt idioms culturally when direct translation loses meaning
   - Keep technical terms accurate

3. **Preserve formatting**:
   - Maintain markdown syntax
   - Keep line breaks and paragraph structure
   - Preserve bold, italic, links, and other formatting
   - Retain code blocks without translation

4. **Cultural adaptation**:
   - Use culturally appropriate equivalents for idioms
   - Adjust examples to target culture when necessary
   - Note if direct translation may cause confusion
</instructions>

## Output Format
<output_format>
[Translated text with original formatting preserved]

[If cultural notes are necessary, add after translation:]
---
**Translator's Note**: [Brief explanation of cultural adaptations made]
</output_format>

## Input Data
<input_data>
Target Language: ${preferredLanguage}
Source Text:
${selection}
</input_data>

## Constraints
<constraints>
- Provide ONLY the translated text (unless translator's notes are essential)
- Do not add explanations, alternatives, or commentary in main output
- Preserve all formatting exactly as in source
- Do not translate: code blocks, URLs, proper nouns (unless culturally adapted)
- If text is already in target language, state "Text is already in ${preferredLanguage}"
- Maintain consistent terminology throughout translation
</constraints>`
    },
  },
  translateToEn: {
    icon: <Globe />,
    label: 'Translate (To English)',
    genPrompt: async (selection) => {
      const targetLanguage = 'English'
      return `## Role
<role>
You are a professional translator with expertise in maintaining semantic accuracy, cultural nuance, and stylistic tone across languages.
</role>

## Task
<task>
Translate the selected text into ${targetLanguage} while preserving the original meaning, tone, style, and formatting.
</task>

## Instructions
<instructions>
1. **Analyze source text**: Identify tone and cultural elements
2. **Translate accurately**: Preserve semantic meaning and style
3. **Preserve formatting**: Maintain markdown and structure
4. **Cultural adaptation**: Use appropriate cultural equivalents
</instructions>

## Output Format
<output_format>
[Translated text with original formatting preserved]
</output_format>

## Input Data
<input_data>
Target Language: ${targetLanguage}
Source Text:
${selection}
</input_data>

## Constraints
<constraints>
- Provide ONLY the translated text
- Preserve all formatting exactly as in source
- If text is already in ${targetLanguage}, state "Text is already in ${targetLanguage}"
</constraints>`
    },
  },
  translateToZh: {
    icon: <Globe />,
    label: 'Translate (To Chinese)',
    genPrompt: async (selection) => {
      const targetLanguage = 'Chinese'
      return `## Role
<role>
You are a professional translator with expertise in maintaining semantic accuracy, cultural nuance, and stylistic tone across languages.
</role>

## Task
<task>
Translate the selected text into ${targetLanguage} while preserving the original meaning, tone, style, and formatting.
</task>

## Instructions
<instructions>
1. **Analyze source text**: Identify tone and cultural elements
2. **Translate accurately**: Preserve semantic meaning and style
3. **Preserve formatting**: Maintain markdown and structure
4. **Cultural adaptation**: Use appropriate cultural equivalents
</instructions>

## Output Format
<output_format>
[Translated text with original formatting preserved]
</output_format>

## Input Data
<input_data>
Target Language: ${targetLanguage}
Source Text:
${selection}
</input_data>

## Constraints
<constraints>
- Provide ONLY the translated text
- Preserve all formatting exactly as in source
- If text is already in ${targetLanguage}, state "Text is already in ${targetLanguage}"
</constraints>`
    },
  },
  translateBidi: {
    icon: <Globe />,
    label: 'Translate (Bidirectional)',
    genPrompt: createGenPrompt({
      isTranslation: true,
      enableBidirectional: true,
    }),
  },
  summary: {
    icon: <CardHeading />,
    label: 'Summary',
    genPrompt: async (selection) => {
      const preferredLanguage = await getPreferredLanguage()
      return `## Role
<role>
You are a professional content summarizer skilled at distilling information to its essential points.
</role>

## Task
<task>
Create a concise summary of the selected content, capturing the main ideas and key points in 2-4 sentences.
</task>

## Instructions
<instructions>
1. **Identify main idea**: Determine the central message or purpose
2. **Extract key points**: Find the 2-4 most important supporting points
3. **Remove details**: Eliminate examples, elaborations, and redundancy
4. **Synthesize**: Combine main idea and key points into coherent summary
5. **Maintain accuracy**: Preserve the original meaning and tone
6. **Be concise**: Target 2-4 sentences maximum
7. **Response language**: Reply in ${preferredLanguage}
</instructions>

## Output Format
<output_format>
[2-4 sentence summary capturing the essence of the content]

**Key Points**:
- [Point 1]
- [Point 2]
- [Point 3]
</output_format>

## Input Data
<input_data>
Content to Summarize:
${selection}
</input_data>

## Constraints
<constraints>
- Maximum 2-4 sentences for main summary
- Focus on "what" and "why," not exhaustive details
- Use clear, direct language
- Do not add interpretation or analysis beyond the source material
- Preserve the original meaning and tone
- If content is too short to summarize, state "Content is already concise"
</constraints>`
    },
  },
  polish: {
    icon: <Palette />,
    label: 'Polish',
    genPrompt: async (selection) => {
      return `## Role
<role>
You are a skilled editor specializing in refining written content for clarity, correctness, and professional presentation.
</role>

## Task
<task>
Edit the selected text to correct errors and improve readability while preserving the original meaning, voice, and intent.
</task>

## Instructions
<instructions>
1. **Correct errors**:
   - Fix grammar, punctuation, and spelling mistakes
   - Correct subject-verb agreement and tense consistency
   - Fix run-on sentences and fragments

2. **Improve word choice**:
   - Replace vague words with specific alternatives
   - Eliminate redundancy and unnecessary words
   - Use stronger, more precise verbs
   - Remove clichés when possible

3. **Enhance readability**:
   - Vary sentence length and structure
   - Improve transitions between ideas
   - Break up overly long sentences
   - Ensure logical flow

4. **Preserve original**:
   - Maintain the author's voice and style
   - Keep the original meaning intact
   - Preserve intended tone (formal, casual, etc.)
   - Retain technical terminology relevant to the domain
</instructions>

## Output Format
<output_format>
[Polished version of the text with improvements applied]

[ONLY provide edited text - no explanations, markup, or commentary]
</output_format>

## Input Data
<input_data>
Original Text:
${selection}
</input_data>

## Constraints
<constraints>
- Return ONLY the polished text (no tracked changes, explanations, or notes)
- Preserve the original meaning and intent exactly
- Maintain the author's voice and perspective
- Keep technical terms and domain-specific language
- Do not add new information or interpretations
- If text needs no editing, return it unchanged
- Make minimal changes necessary for improvement
</constraints>`
    },
  },
  sentiment: {
    icon: <EmojiSmile />,
    label: 'Sentiment Analysis',
    genPrompt: async (selection) => {
      const preferredLanguage = await getPreferredLanguage()
      return `## Role
<role>
You are an expert in sentiment analysis and emotional intelligence, skilled at identifying emotional tone in written content.
</role>

## Task
<task>
Analyze the emotional tone of the selected content and provide a clear sentiment classification with supporting explanation.
</task>

## Instructions
<instructions>
1. **Read content holistically**: Consider overall emotional tone, not just individual words
2. **Identify primary sentiment**:
   - Positive (optimistic, enthusiastic, satisfied)
   - Negative (critical, frustrated, disappointed)
   - Neutral (objective, factual, balanced)
   - Mixed (contains both positive and negative elements)
3. **Assess intensity**: Strong, moderate, or mild
4. **Note emotional nuances**: Specific emotions present (joy, anger, fear, surprise, sadness)
5. **Consider context**: Sarcasm, irony, cultural factors
6. **Provide confidence level**: High, moderate, or low confidence in assessment
7. **Response language**: Reply in ${preferredLanguage}
</instructions>

## Output Format
<output_format>
**Sentiment**: [Positive | Negative | Neutral | Mixed]
**Intensity**: [Strong | Moderate | Mild]
**Confidence**: [High | Moderate | Low]

**Emotional Tone**: [2-3 descriptive words, e.g., "Enthusiastic and hopeful" or "Frustrated and critical"]

**Explanation**: [1-2 sentences describing why this sentiment was identified, referencing specific indicators in the text]

**Key Emotional Indicators**:
- [Phrase or word showing sentiment]
- [Another indicator]
</output_format>

## Input Data
<input_data>
Content to Analyze:
${selection}
</input_data>

## Constraints
<constraints>
- Base analysis solely on provided text
- Consider context and nuance (sarcasm, irony)
- If sentiment is ambiguous, mark as "Mixed" or note low confidence
- Distinguish between sentiment about topic vs. sentiment of writing style
- Acknowledge when content is too short or neutral to assess meaningfully
- Use objective, non-judgmental language in analysis
</constraints>`
    },
  },
  divide: {
    icon: <CardList />,
    label: 'Divide Paragraphs',
    genPrompt: createGenPrompt({
      message:
        'You are a skilled editor. Divide the following text into clear, easy-to-read and easy-to-understand paragraphs',
    }),
  },
  code: {
    icon: <Braces />,
    label: 'Code Explain',
    genPrompt: async (selection) => {
      const preferredLanguage = await getPreferredLanguage()
      return `## Role
<role>
You are a senior software engineer and system architect with expertise in code analysis, design patterns, and best practices across multiple programming languages.
</role>

## Task
<task>
Analyze the provided code snippet, explaining its functionality, design decisions, and potential issues in a clear, educational manner.
</task>

## Instructions
<instructions>
1. **Identify language and context**:
   - Determine programming language
   - Recognize framework or library usage
   - Note coding style and patterns

2. **Break down the code**:
   - Explain each significant line or block
   - Describe what each part does
   - Show how components interact

3. **Explain design decisions**:
   - Why this approach was likely chosen
   - What problem it solves
   - Trade-offs in this implementation

4. **Identify potential issues**:
   - Performance concerns
   - Security vulnerabilities
   - Edge cases not handled
   - Code smells or anti-patterns
   - Areas for improvement

5. **Summarize purpose**:
   - Overall goal of the code
   - How it fits into larger system
   - Key takeaways for understanding

6. **Response language**: Reply in ${preferredLanguage}
</instructions>

## Output Format
<output_format>
## Overview
[One-sentence description of what this code does]

## Code Breakdown

### [Section/Function 1]
\`\`\`[language]
[relevant code snippet]
\`\`\`
**What it does**: [Explanation]
**How it works**: [Step-by-step breakdown]
**Why this approach**: [Design rationale]

### [Section/Function 2]
[Continue pattern for each significant part]

## Design Decisions
- **Decision 1**: [What and why]
- **Decision 2**: [What and why]

## Potential Issues
⚠️ **[Issue type]**: [Description]
- **Impact**: [What could go wrong]
- **Recommendation**: [How to improve]

✅ **Good practices observed**:
- [Positive aspects]

## Summary
**Purpose**: [Overall goal and function]
**Key Concepts**: [Main ideas demonstrated]
**Complexity**: [Simple | Moderate | Complex]
**Best for**: [Use cases where this code pattern is appropriate]
</output_format>

## Input Data
<input_data>
Code to Analyze:
\`\`\`
${selection}
\`\`\`
</input_data>

## Constraints
<constraints>
- Assume reader has basic programming knowledge but may not know this specific language
- Explain technical terms when first used
- Be constructive when noting issues (suggest improvements, don't just criticize)
- If code context is insufficient to fully explain, note assumptions made
- Focus on understanding, not just critiquing
- Use accurate technical terminology
- Provide specific, actionable recommendations for improvements
</constraints>`
    },
  },
  ask: {
    icon: <QuestionCircle />,
    label: 'Ask',
    genPrompt: createGenPrompt({
      message:
        'Analyze the following content carefully and provide a concise answer or opinion with a short explanation',
      includeLanguagePrefix: true,
    }),
  },
}
