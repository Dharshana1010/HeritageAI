export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export interface Manuscript {
  id: string;
  userId: string;
  imageUrl: string;
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
  uploadDate: string;
}

export type AppSection = 'home' | 'upload' | 'results' | 'graph' | 'search' | 'archive' | 'profile';
