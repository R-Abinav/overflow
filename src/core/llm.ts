import { ENV } from '../config/env.config';
import { Anthropic } from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';

export interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
}

export async function askLLM(systemPrompt: string, messages: ChatMessage[]): Promise<string> {
    if (ENV.GEMINI_API_KEY) {
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
    } else if (ENV.ANTHROPIC_API_KEY) {
        console.log('[llm] Using Anthropic API');
        const anthropic = new Anthropic({ apiKey: ENV.ANTHROPIC_API_KEY });
        
        const response = await anthropic.messages.create({
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 4096,
            system: systemPrompt,
            messages: messages.map(m => ({
                role: m.role,
                content: m.content
            }))
        });

        const content = response.content[0];
        if (content.type !== 'text') {
            throw new Error('Expected text response from Anthropic');
        }
        return content.text;
    } else {
        throw new Error('No LLM API key provided. Set GEMINI_API_KEY or ANTHROPIC_API_KEY');
    }
}
