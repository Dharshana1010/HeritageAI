import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

export interface DigitizationResult {
  title: string;
  period: string;
  rawText: string;
  summary: string;
  translatedText: string;
  historicalInsight: string;
  entities: {
    kings: string[];
    places: string[];
    temples: string[];
    events: string[];
    dynasties: string[];
  };
}

export async function digitizeManuscript(base64Image: string, retries = 1): Promise<DigitizationResult> {
  const model = "gemini-3-flash-preview";
  
  const systemInstruction = "You are an expert epigraphist. Analyze the manuscript image and provide a structured JSON response. Be concise and fast.";
  
  const prompt = `
    Extract from this manuscript:
    1. title: A short, descriptive title for the manuscript.
    2. period: Estimated historical period or date.
    3. rawText: Original script.
    4. summary: A concise but comprehensive overview.
    5. translatedText: English translation.
    6. historicalInsight: Context.
    7. entities: kings, places, temples, events, dynasties.
  `;

  const imagePart = {
    inlineData: {
      mimeType: "image/jpeg",
      data: base64Image.split(',')[1] || base64Image,
    },
  };

  try {
    const generatePromise = ai.models.generateContent({
      model,
      contents: [{ parts: [imagePart, { text: prompt }] }],
      config: {
        systemInstruction,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            period: { type: Type.STRING },
            rawText: { type: Type.STRING },
            summary: { type: Type.STRING },
            translatedText: { type: Type.STRING },
            historicalInsight: { type: Type.STRING },
            entities: {
              type: Type.OBJECT,
              properties: {
                kings: { type: Type.ARRAY, items: { type: Type.STRING } },
                places: { type: Type.ARRAY, items: { type: Type.STRING } },
                temples: { type: Type.ARRAY, items: { type: Type.STRING } },
                events: { type: Type.ARRAY, items: { type: Type.STRING } },
                dynasties: { type: Type.ARRAY, items: { type: Type.STRING } },
              },
            },
          },
        },
      },
    });

    // Add a 45-second timeout to the API call
    const timeoutPromise = new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error('Digitization request timed out. Please try again.')), 45000)
    );

    const response = await Promise.race([generatePromise, timeoutPromise]);

    const result = JSON.parse(response.text || '{}');
    
    // Ensure entities structure exists to prevent UI crashes
    const defaultEntities = { kings: [], places: [], temples: [], events: [], dynasties: [] };
    result.entities = { ...defaultEntities, ...(result.entities || {}) };
    ['kings', 'places', 'temples', 'events', 'dynasties'].forEach(key => {
      if (!Array.isArray(result.entities[key])) result.entities[key] = [];
    });

    return result as DigitizationResult;
  } catch (error) {
    if (retries > 0) {
      console.warn(`Digitization failed, retrying... (${retries} attempts left)`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      return digitizeManuscript(base64Image, retries - 1);
    }
    console.error('Final digitization attempt failed:', error);
    throw error;
  }
}

export async function semanticSearch(query: string, manuscripts: any[]) {
  // Simple semantic search using Gemini to rank or filter
  const model = "gemini-3-flash-preview";
  const prompt = `
    Search Query: "${query}"
    Manuscripts:
    ${manuscripts.map((m, i) => `${i}: [${m.title}] ${m.summary}`).join('\n')}

    Return a JSON array of indices of the most relevant manuscripts, sorted by relevance.
  `;

  const response = await ai.models.generateContent({
    model,
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: { type: Type.INTEGER }
      }
    }
  });

  const indices = JSON.parse(response.text || '[]');
  return indices.map((i: number) => manuscripts[i]);
}
