import { getUserConfig } from '../../config/index.mjs';
import { pushRecord } from './shared.mjs'; // Assuming this is used for history
// import { fetchSSE } from '../../utils/fetch-sse.mjs'; // If streaming is needed

// Placeholder for the actual Gemini API endpoint
const GEMINI_API_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent';

export async function generateAnswersWithGeminiApi(port, question, session) {
  const config = await getUserConfig();
  const apiKey = config.geminiApiKey;

  if (!apiKey) {
    port.postMessage({ error: 'Gemini API key not configured.', done: true, session });
    return;
  }

  try {
    // Construct the request payload
    // This is a placeholder structure and needs to be verified against Gemini API documentation
    const payload = {
      contents: [{
        parts: [{
          text: question,
        }],
      }],
      // generationConfig: { // Optional: configure temperature, maxOutputTokens, etc.
      //   temperature: config.temperature,
      //   maxOutputTokens: config.maxResponseTokenLength,
      // },
      // safetySettings: [ // Optional: configure safety settings
      //   { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      //   { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      //   { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      //   { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      // ],
    };

    const response = await fetch(`${GEMINI_API_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: response.statusText }));
      console.error('Gemini API error:', errorData);
      port.postMessage({ error: `Gemini API error: ${errorData.error?.message || errorData.message || 'Unknown error'}`, done: true, session });
      return;
    }

    const responseData = await response.json();
    
    // Extract the answer from the responseData
    // This is a placeholder and needs to be verified against actual Gemini API response structure
    // Expected structure: responseData.candidates[0].content.parts[0].text
    let answer = 'No response from Gemini API.';
    if (responseData.candidates && responseData.candidates[0] && responseData.candidates[0].content && responseData.candidates[0].content.parts && responseData.candidates[0].content.parts[0]) {
      answer = responseData.candidates[0].content.parts[0].text;
    } else {
        console.error('Unexpected Gemini API response structure:', responseData);
    }

    pushRecord(session, question, answer);
    // console.debug('Gemini conversation history', { content: session.conversationRecords });
    port.postMessage({ answer: answer, done: true, session: session });

  } catch (err) {
    console.error('Error in generateAnswersWithGeminiApi:', err);
    port.postMessage({ error: err.message || 'Failed to communicate with Gemini API.', done: true, session });
  }
}
