import { ENV } from '../config/env.config';
import { Anthropic } from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';

export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}

export async function askLLM(systemPrompt: string, messages: ChatMessage[]): Promise<string> {
    if (ENV.ANTHROPIC_API_KEY) {
        console.log('[llm] Using Anthropic API');
        const anthropic = new Anthropic({ apiKey: ENV.ANTHROPIC_API_KEY });

        const response = await anthropic.messages.create({
            model: 'claude-sonnet-5',
            max_tokens: 4096,
            system: systemPrompt,
            messages: messages.map(m => ({
                role: m.role,
                content: m.content
            }))
        });

        // Claude 5 can return a leading `thinking` content block before the
        // actual `text` block (observed: present for some objectives, absent
        // for others — not predictable from the prompt alone), so the text
        // response is not reliably content[0]. Find the text block by type
        // instead of assuming its position.
        const textBlock = response.content.find((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text');
        if (!textBlock) {
            throw new Error('No text block in Anthropic response (content types: ' + response.content.map(b => b.type).join(', ') + ')');
        }
        return textBlock.text;
    } else if (ENV.GEMINI_API_KEY) {
        console.log('[llm] Using Gemini API');
        const ai = new GoogleGenAI({ apiKey: ENV.GEMINI_API_KEY });

        let combinedSystemPrompt = systemPrompt;
        const geminiMessages = messages.map(m => {
            if (m.role === 'user') {
                return { role: 'user', parts: [{ text: m.content }] };
            } else {
                return { role: 'model', parts: [{ text: m.content }] };
            }
        });

        const response = await ai.models.generateContent({
            model: 'gemini-3.1-flash-lite',
            contents: geminiMessages,
            config: {
                systemInstruction: combinedSystemPrompt,
                temperature: 0,
            }
        });

        if (!response.text) {
             throw new Error('Empty response from Gemini');
        }
        return response.text;
    } else {
        throw new Error('No LLM API key provided. Set ANTHROPIC_API_KEY or GEMINI_API_KEY');
    }
}
