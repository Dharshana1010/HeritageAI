import React, { useState, useEffect, useRef } from 'react';
import { 
  History, 
  Upload, 
  Search, 
  Archive, 
  User, 
  Home, 
  Database, 
  Share2, 
  ChevronRight, 
  Loader2, 
  FileText, 
  Languages, 
  Sparkles, 
  LogOut,
  MapPin,
  Calendar,
  Crown,
  Building2,
  Trophy
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { auth, db, signInWithGoogle, logout, handleFirestoreError, OperationType } from './firebase';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { collection, addDoc, query, where, onSnapshot, orderBy, serverTimestamp, doc, setDoc } from 'firebase/firestore';
import { Manuscript, AppSection } from './types';
import { digitizeManuscript, semanticSearch } from './services/geminiService';
import KnowledgeGraph from './components/KnowledgeGraph';
import ReactMarkdown from 'react-markdown';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const resizeImage = (base64Str: string, maxWidth = 1000, maxHeight = 1000): Promise<string> => {
  return new Promise((resolve, reject) => {
    // If the image is already small, skip resizing to save time
    if (base64Str.length < 500000) { // ~500KB
      return resolve(base64Str);
    }

    const img = new Image();
    const timeout = setTimeout(() => reject(new Error('Image processing timed out')), 10000);
    img.src = base64Str;
    img.onload = () => {
      clearTimeout(timeout);
      let width = img.width;
      let height = img.height;
      
      const ratio = Math.min(maxWidth / width, maxHeight / height);
      if (ratio < 1) {
        width *= ratio;
        height *= ratio;
      } else {
        // If the image is already smaller than maxWidth/maxHeight, just return it
        return resolve(base64Str);
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.7)); // Lower quality for faster upload
    };
    img.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('Failed to load image for resizing'));
    };
  });
};

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      let errorMessage = "An unexpected error occurred.";
      try {
        const parsedError = JSON.parse(this.state.error?.message || "");
        if (parsedError.error) errorMessage = `Firestore Error: ${parsedError.error} (${parsedError.operationType} at ${parsedError.path})`;
      } catch {
        errorMessage = this.state.error?.message || errorMessage;
      }

      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white rounded-3xl shadow-xl p-8 text-center border border-red-100">
            <div className="w-16 h-16 bg-red-50 text-red-500 rounded-2xl flex items-center justify-center mx-auto mb-6">
              <Sparkles size={32} className="rotate-45" />
            </div>
            <h2 className="text-2xl font-bold text-slate-900 mb-4">Something went wrong</h2>
            <p className="text-slate-500 mb-8">{errorMessage}</p>
            <button 
              onClick={() => window.location.reload()}
              className="w-full py-4 bg-slate-900 text-white rounded-xl font-semibold hover:bg-slate-800 transition-all"
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [activeSection, setActiveSection] = useState<AppSection>('home');
  const [manuscripts, setManuscripts] = useState<Manuscript[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingStatus, setProcessingStatus] = useState<string | null>(null);
  const [processingError, setProcessingError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<Manuscript | null>(null);
  const [currentProcessingImage, setCurrentProcessingImage] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Manuscript[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        // Sync user profile to Firestore
        const userRef = doc(db, 'users', u.uid);
        try {
          await setDoc(userRef, {
            uid: u.uid,
            email: u.email,
            displayName: u.displayName,
            photoURL: u.photoURL,
            lastLogin: serverTimestamp(),
            updatedAt: serverTimestamp()
          }, { merge: true });
        } catch (error) {
          console.error('Error syncing user profile:', error);
          // We don't use handleFirestoreError here to avoid crashing the whole app on login
        }
      }
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) return;
    const path = 'manuscripts';
    const q = query(
      collection(db, path),
      where('userId', '==', user.uid),
      orderBy('uploadDate', 'desc')
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Manuscript));
      setManuscripts(docs);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    });
    return () => unsubscribe();
  }, [user]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    setIsProcessing(true);
    setProcessingStatus('Reading file...');
    setProcessingError(null);
    setLastResult(null);
    setActiveSection('results');

    const reader = new FileReader();
    reader.onloadend = async () => {
      try {
        let base64 = reader.result as string;
        setCurrentProcessingImage(base64);
        
        // Resize image to prevent payload size issues
        try {
          setProcessingStatus('Optimizing image...');
          base64 = await resizeImage(base64);
          setCurrentProcessingImage(base64);
        } catch (resizeErr) {
          console.warn('Image resizing failed, proceeding with original:', resizeErr);
        }

        setProcessingStatus('Analyzing manuscript with AI...');
        const result = await digitizeManuscript(base64);
        
        const manuscriptData = {
          userId: user.uid,
          imageUrl: base64,
          ...result,
          uploadDate: new Date().toISOString(),
          createdAt: serverTimestamp()
        };

        // Update UI immediately with a temporary ID for speed
        const tempId = `temp-${Date.now()}`;
        setLastResult({ id: tempId, ...manuscriptData } as Manuscript);
        setProcessingStatus(null);
        setIsProcessing(false);

        // Save to Firestore in the background
        const path = 'manuscripts';
        addDoc(collection(db, path), manuscriptData).then(docRef => {
          setLastResult(prev => (prev?.id === tempId ? { ...prev, id: docRef.id } : prev));
        }).catch(err => {
          console.error('Background save failed:', err);
          handleFirestoreError(err, OperationType.CREATE, path);
        });
      } catch (error) {
        console.error('Error processing manuscript:', error);
        setProcessingError(error instanceof Error ? error.message : 'An unexpected error occurred during digitization.');
        setIsProcessing(false);
      } finally {
        // We don't set isProcessing to false here if it was already set to false on success
        // to avoid any race conditions with the UI transition.
        // But we should ensure it's false if there was an error.
        setCurrentProcessingImage(null);
        setProcessingStatus(null);
      }
    };
    reader.onerror = () => {
      setProcessingError('Failed to read the uploaded file.');
      setIsProcessing(false);
      setProcessingStatus(null);
    };
    reader.readAsDataURL(file);
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const results = await semanticSearch(searchQuery, manuscripts);
      setSearchResults(results);
    } catch (error) {
      console.error('Search error:', error);
    } finally {
      setIsSearching(false);
    }
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full bg-white rounded-3xl shadow-xl p-8 text-center border border-slate-200"
        >
          <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <History size={32} />
          </div>
          <h1 className="text-3xl font-bold text-slate-900 mb-2">HeritageAI</h1>
          <p className="text-slate-500 mb-8">Ancient Text Digitalization & Knowledge Extraction System</p>
          <button 
            onClick={signInWithGoogle}
            className="w-full py-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-semibold transition-all flex items-center justify-center gap-3 shadow-lg shadow-emerald-200"
          >
            <User size={20} />
            Sign in with Google
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-slate-50 flex">
        {/* Sidebar */}
        <aside className="w-72 bg-white border-r border-slate-200 flex flex-col p-6 fixed h-full">
          <div className="flex items-center gap-3 mb-12">
            <div className="w-10 h-10 bg-emerald-600 text-white rounded-xl flex items-center justify-center">
              <History size={24} />
            </div>
            <span className="text-xl font-bold text-slate-900">HeritageAI</span>
          </div>

          <nav className="flex-1 space-y-2">
            <NavItem icon={<Home size={20} />} label="Home" active={activeSection === 'home'} onClick={() => setActiveSection('home')} />
            <NavItem icon={<Upload size={20} />} label="Upload Manuscript" active={activeSection === 'upload'} onClick={() => setActiveSection('upload')} />
            <NavItem icon={<Database size={20} />} label="Digital Archive" active={activeSection === 'archive'} onClick={() => setActiveSection('archive')} />
            <NavItem icon={<Search size={20} />} label="Semantic Search" active={activeSection === 'search'} onClick={() => setActiveSection('search')} />
            <NavItem icon={<Share2 size={20} />} label="Knowledge Graph" active={activeSection === 'graph'} onClick={() => setActiveSection('graph')} />
            <NavItem icon={<User size={20} />} label="User Profile" active={activeSection === 'profile'} onClick={() => setActiveSection('profile')} />
          </nav>

          <div className="pt-6 border-t border-slate-100">
            <button 
              onClick={logout}
              className="flex items-center gap-3 text-slate-500 hover:text-red-600 transition-colors w-full px-4 py-3 rounded-xl hover:bg-red-50"
            >
              <LogOut size={20} />
              <span className="font-medium">Sign Out</span>
            </button>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 ml-72 p-10">
          <AnimatePresence mode="wait">
            {activeSection === 'home' && (
              <motion.div 
                key="home"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="max-w-5xl mx-auto"
              >
                <header className="mb-12">
                  <h2 className="text-4xl font-bold text-slate-900 mb-4">Welcome back, {user.displayName}</h2>
                  <p className="text-lg text-slate-500">Preserving history through advanced AI digitalization.</p>
                </header>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
                  <StatCard label="Manuscripts" value={manuscripts.length} icon={<FileText className="text-emerald-600" />} />
                  <StatCard label="Entities Found" value={manuscripts.reduce((acc, m) => acc + (m.entities ? Object.values(m.entities).flat().length : 0), 0)} icon={<Sparkles className="text-amber-600" />} />
                  <StatCard label="Languages" value="Tamil, Sanskrit" icon={<Languages className="text-blue-600" />} />
                </div>

                <div className="bg-white rounded-3xl p-8 border border-slate-200 shadow-sm">
                  <h3 className="text-xl font-bold text-slate-900 mb-6">Recent Activity</h3>
                  <div className="space-y-4">
                    {manuscripts.slice(0, 3).map(m => (
                      <div key={m.id} className="flex items-center justify-between p-4 rounded-2xl bg-slate-50 border border-slate-100">
                        <div className="flex items-center gap-4">
                          <img src={m.imageUrl} alt="Manuscript" className="w-12 h-12 rounded-lg object-cover" />
                          <div>
                            <p className="font-semibold text-slate-900 truncate max-w-[200px]">{m.summary || 'Untitled Manuscript'}</p>
                            <p className="text-xs text-slate-500">{new Date(m.uploadDate).toLocaleDateString()}</p>
                          </div>
                        </div>
                        <button 
                          onClick={() => { setLastResult(m); setProcessingError(null); setActiveSection('results'); }}
                          className="p-2 text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors"
                        >
                          <ChevronRight size={20} />
                        </button>
                      </div>
                    ))}
                    {manuscripts.length === 0 && <p className="text-slate-400 text-center py-8">No manuscripts uploaded yet.</p>}
                  </div>
                </div>
              </motion.div>
            )}

            {activeSection === 'upload' && (
              <motion.div 
                key="upload"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="max-w-3xl mx-auto"
              >
                <div className="bg-white rounded-3xl p-12 border-2 border-dashed border-slate-200 text-center">
                  <div className="w-20 h-20 bg-emerald-50 text-emerald-600 rounded-3xl flex items-center justify-center mx-auto mb-6">
                    <Upload size={40} />
                  </div>
                  <h2 className="text-2xl font-bold text-slate-900 mb-2">Upload Manuscript</h2>
                  <p className="text-slate-500 mb-8">Support for Palm Leaf texts, Inscriptions, and Historical Documents (JPG, PNG, TIFF)</p>
                  <label className="inline-block px-8 py-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-semibold cursor-pointer transition-all shadow-lg shadow-emerald-100">
                    Select File
                    <input type="file" className="hidden" accept="image/*" onChange={handleUpload} />
                  </label>
                </div>
              </motion.div>
            )}

            {activeSection === 'results' && (
              <motion.div 
                key="results"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="max-w-7xl mx-auto"
              >
                {isProcessing ? (
                  <div className="flex flex-col items-center justify-center py-12">
                    <div className="relative mb-8">
                      <Loader2 className="w-20 h-20 text-emerald-600 animate-spin" />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <Sparkles className="text-emerald-500 animate-pulse" size={24} />
                      </div>
                    </div>
                    
                    {currentProcessingImage && (
                      <motion.div 
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="w-64 aspect-video rounded-2xl overflow-hidden border-4 border-white shadow-2xl mb-8 relative group"
                      >
                        <img src={currentProcessingImage} alt="Processing" className="w-full h-full object-cover grayscale opacity-50" />
                        <div className="absolute inset-0 bg-emerald-600/20 mix-blend-overlay animate-pulse" />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="px-4 py-2 bg-black/60 backdrop-blur-md rounded-full text-white text-xs font-bold uppercase tracking-widest">
                            Analyzing Script...
                          </div>
                        </div>
                      </motion.div>
                    )}

                    <h3 className="text-3xl font-bold text-slate-900 mb-2">{processingStatus || "Digitizing Manuscript..."}</h3>
                    <p className="text-slate-500 max-w-md text-center">
                      Our AI is currently transcribing, translating, and extracting historical entities from your document. This may take up to a minute.
                    </p>
                    <button 
                      onClick={() => { setIsProcessing(false); setActiveSection('upload'); }}
                      className="mt-8 text-slate-400 hover:text-slate-600 font-medium transition-colors"
                    >
                      Cancel Processing
                    </button>
                  </div>
                ) : processingError ? (
                  <div className="flex flex-col items-center justify-center py-20 text-center">
                    <div className="w-16 h-16 bg-red-50 text-red-500 rounded-2xl flex items-center justify-center mb-6">
                      <LogOut size={32} className="rotate-90" />
                    </div>
                    <h3 className="text-2xl font-bold text-slate-900 mb-2">Digitization Failed</h3>
                    <p className="text-slate-500 mb-8 max-w-md">{processingError}</p>
                    <button 
                      onClick={() => setActiveSection('upload')}
                      className="px-8 py-3 bg-slate-900 text-white rounded-xl font-semibold hover:bg-slate-800 transition-colors"
                    >
                      Try Again
                    </button>
                  </div>
                ) : lastResult ? (
                  <div className="space-y-8">
                    {/* Top Bar with Summary */}
                    <div className="bg-white rounded-3xl p-8 border border-slate-200 shadow-sm flex flex-col md:flex-row gap-8 items-center">
                      <div className="w-full md:w-1/3 aspect-video rounded-2xl overflow-hidden border border-slate-100">
                        <img src={lastResult.imageUrl} alt="Original" className="w-full h-full object-cover" />
                      </div>
                      <div className="flex-1">
                        <h3 className="text-3xl font-bold text-slate-900 mb-2">{lastResult.title || "Untitled Manuscript"}</h3>
                        <p className="text-sm font-semibold text-emerald-600 mb-4 tracking-wide uppercase">{lastResult.period || "Unknown Period"}</p>
                        <div className="flex flex-wrap gap-2">
                          {lastResult.entities?.kings?.slice(0, 3).map(k => <span key={k} className="px-3 py-1 bg-blue-50 text-blue-600 text-xs rounded-full font-medium">King {k}</span>)}
                          {lastResult.entities?.places?.slice(0, 3).map(p => <span key={p} className="px-3 py-1 bg-emerald-50 text-emerald-600 text-xs rounded-full font-medium">{p}</span>)}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                      {/* Left Column: Transcription & Translation */}
                      <div className="lg:col-span-2 space-y-8">
                        <ResultSection 
                          title="Raw Text Extraction" 
                          icon={<FileText size={20} className="text-emerald-600" />} 
                          content={lastResult.rawText} 
                          badge="AI EXTRACTED"
                        />
                        <ResultSection 
                          title="Modern English Translation" 
                          icon={<Languages size={20} className="text-blue-600" />} 
                          content={lastResult.translatedText} 
                          badge="AI TRANSLATED"
                        />
                        <div className="bg-white rounded-3xl p-8 border border-slate-200 shadow-sm">
                          <h3 className="text-xl font-bold text-slate-900 mb-6 flex items-center gap-2">
                            <History size={20} className="text-violet-600" />
                            Historical Insights & Context
                          </h3>
                          <div className="prose prose-slate max-w-none">
                            <p className="text-slate-600 leading-relaxed text-lg italic bg-slate-50 p-6 rounded-2xl border border-slate-100">
                              "{lastResult.historicalInsight || "No historical insights or context available for this manuscript."}"
                            </p>
                          </div>
                        </div>
                      </div>

                      {/* Right Column: Knowledge Graph & Entities */}
                      <div className="space-y-8">
                        <div className="h-[500px]">
                          <KnowledgeGraph manuscripts={manuscripts} highlightId={lastResult.id} />
                        </div>
                        
                        <div className="bg-white rounded-3xl p-8 border border-slate-200 shadow-sm">
                          <h3 className="text-xl font-bold text-slate-900 mb-6">Entity Breakdown</h3>
                          <div className="space-y-6">
                            <EntityGroup icon={<Crown className="text-blue-500" />} label="Kings" items={lastResult.entities?.kings || []} />
                            <EntityGroup icon={<Trophy className="text-pink-500" />} label="Dynasties" items={lastResult.entities?.dynasties || []} />
                            <EntityGroup icon={<Building2 className="text-amber-500" />} label="Temples" items={lastResult.entities?.temples || []} />
                            <EntityGroup icon={<MapPin className="text-emerald-500" />} label="Places" items={lastResult.entities?.places || []} />
                            <EntityGroup icon={<Calendar className="text-violet-500" />} label="Events" items={lastResult.entities?.events || []} />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-20">
                    <p className="text-slate-400">Upload a manuscript to see results.</p>
                  </div>
                )}
              </motion.div>
            )}

            {activeSection === 'archive' && (
              <motion.div 
                key="archive"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="max-w-6xl mx-auto"
              >
                <header className="mb-12 flex justify-between items-end">
                  <div>
                    <h2 className="text-4xl font-bold text-slate-900 mb-2">Digital Archive</h2>
                    <p className="text-slate-500">Your personal collection of digitized historical records.</p>
                  </div>
                  <div className="text-right">
                    <p className="text-3xl font-bold text-emerald-600">{manuscripts.length}</p>
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Total Records</p>
                  </div>
                </header>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                  {manuscripts.map(m => (
                    <motion.div 
                      key={m.id}
                      whileHover={{ y: -5 }}
                      className="bg-white rounded-3xl overflow-hidden border border-slate-200 shadow-sm group cursor-pointer"
                      onClick={() => { setLastResult(m); setProcessingError(null); setActiveSection('results'); }}
                    >
                      <div className="aspect-video overflow-hidden">
                        <img src={m.imageUrl} alt="Manuscript" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                      </div>
                      <div className="p-6">
                        <div className="flex items-center gap-2 mb-3">
                          <span className="px-2 py-1 bg-emerald-50 text-emerald-600 text-[10px] font-bold rounded uppercase tracking-wider">Digitized</span>
                          <span className="text-[10px] text-slate-400">{new Date(m.uploadDate).toLocaleDateString()}</span>
                        </div>
                        <h4 className="font-bold text-slate-900 mb-1 line-clamp-1">{m.title || "Untitled"}</h4>
                        <p className="text-[10px] font-bold text-emerald-600 uppercase mb-4">{m.period}</p>
                        <div className="flex flex-wrap gap-1">
                          {m.entities && Object.values(m.entities).flat().slice(0, 3).map((e, i) => (
                            <span key={i} className="px-2 py-0.5 bg-slate-100 text-slate-600 text-[10px] rounded-full">{e}</span>
                          ))}
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            )}

            {activeSection === 'search' && (
              <motion.div 
                key="search"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="max-w-4xl mx-auto"
              >
                <div className="mb-12">
                  <h2 className="text-4xl font-bold text-slate-900 mb-4">Semantic Search</h2>
                  <p className="text-slate-500 mb-8">Search manuscripts using meaning-based queries like "temple construction" or "royal land grants".</p>
                  
                  <div className="relative">
                    <input 
                      type="text" 
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                      placeholder="Enter your search query..."
                      className="w-full pl-14 pr-32 py-5 bg-white border border-slate-200 rounded-2xl shadow-sm focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none transition-all text-lg"
                    />
                    <Search className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-400" size={24} />
                    <button 
                      onClick={handleSearch}
                      disabled={isSearching}
                      className="absolute right-3 top-1/2 -translate-y-1/2 px-6 py-3 bg-emerald-600 text-white rounded-xl font-semibold hover:bg-emerald-700 transition-colors disabled:opacity-50"
                    >
                      {isSearching ? <Loader2 className="animate-spin" size={20} /> : 'Search'}
                    </button>
                  </div>
                </div>

                <div className="space-y-6">
                  {searchResults.map(m => (
                    <div 
                      key={m.id} 
                      className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm flex gap-6 cursor-pointer hover:border-emerald-200 transition-colors"
                      onClick={() => { setLastResult(m); setProcessingError(null); setActiveSection('results'); }}
                    >
                      <img src={m.imageUrl} alt="Manuscript" className="w-32 h-32 rounded-2xl object-cover" />
                      <div>
                        <h4 className="text-xl font-bold text-slate-900 mb-1">{m.title || "Untitled"}</h4>
                        <p className="text-xs font-bold text-emerald-600 uppercase mb-4">{m.period}</p>
                        <div className="flex gap-2">
                          {m.entities?.kings?.slice(0, 2).map(k => <span key={k} className="px-3 py-1 bg-blue-50 text-blue-600 text-xs rounded-full">{k}</span>)}
                          {m.entities?.places?.slice(0, 2).map(p => <span key={p} className="px-3 py-1 bg-emerald-50 text-emerald-600 text-xs rounded-full">{p}</span>)}
                        </div>
                      </div>
                    </div>
                  ))}
                  {searchQuery && searchResults.length === 0 && !isSearching && (
                    <div className="text-center py-20 bg-white rounded-3xl border border-slate-200">
                      <p className="text-slate-400">No matching manuscripts found.</p>
                    </div>
                  )}
                </div>
              </motion.div>
            )}

            {activeSection === 'graph' && (
              <motion.div 
                key="graph"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="max-w-6xl mx-auto"
              >
                <header className="mb-12">
                  <h2 className="text-4xl font-bold text-slate-900 mb-2">Global Knowledge Graph</h2>
                  <p className="text-slate-500">Visualizing relationships between all digitized historical entities.</p>
                </header>

                <div className="h-[600px] bg-white rounded-3xl border border-slate-200 shadow-sm relative overflow-hidden">
                  {manuscripts.length > 0 ? (
                    <KnowledgeGraph manuscripts={manuscripts} />
                  ) : (
                    <div className="flex items-center justify-center h-full">
                      <p className="text-slate-400">Upload manuscripts to generate the knowledge graph.</p>
                    </div>
                  )}
                </div>
              </motion.div>
            )}

            {activeSection === 'profile' && (
              <motion.div 
                key="profile"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="max-w-3xl mx-auto"
              >
                <div className="bg-white rounded-3xl p-12 border border-slate-200 shadow-sm text-center">
                  <div className="w-24 h-24 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-6 overflow-hidden border-4 border-white shadow-lg">
                    {user.photoURL ? <img src={user.photoURL} alt="Avatar" /> : <User size={48} className="text-slate-400" />}
                  </div>
                  <h2 className="text-2xl font-bold text-slate-900 mb-1">{user.displayName}</h2>
                  <p className="text-slate-500 mb-8">{user.email}</p>
                  
                  <div className="grid grid-cols-2 gap-4 text-left">
                    <div className="p-6 bg-slate-50 rounded-2xl border border-slate-100">
                      <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Member Since</p>
                      <p className="font-semibold text-slate-900">{new Date(user.metadata.creationTime || '').toLocaleDateString()}</p>
                    </div>
                    <div className="p-6 bg-slate-50 rounded-2xl border border-slate-100">
                      <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1">Total Contributions</p>
                      <p className="font-semibold text-slate-900">{manuscripts.length} Manuscripts</p>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>
    </ErrorBoundary>
  );
}

function NavItem({ icon, label, active, onClick }: { icon: React.ReactNode, label: string, active: boolean, onClick: () => void }) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 w-full px-4 py-3 rounded-xl transition-all font-medium",
        active 
          ? "bg-emerald-50 text-emerald-700 shadow-sm shadow-emerald-100/50" 
          : "text-slate-500 hover:bg-slate-50 hover:text-slate-900"
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function StatCard({ label, value, icon }: { label: string, value: string | number, icon: React.ReactNode }) {
  return (
    <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm">
      <div className="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center mb-4">
        {icon}
      </div>
      <p className="text-3xl font-bold text-slate-900 mb-1">{value}</p>
      <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">{label}</p>
    </div>
  );
}

function ResultSection({ title, icon, content, badge }: { title: string, icon: React.ReactNode, content: string, badge?: string }) {
  return (
    <div className="bg-white rounded-3xl p-8 border border-slate-200 shadow-sm">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-xl font-bold text-slate-900 flex items-center gap-2">
          {icon}
          {title}
        </h3>
        {badge && (
          <span className="px-2 py-1 bg-slate-100 text-slate-500 text-[10px] font-bold rounded uppercase tracking-wider">
            {badge}
          </span>
        )}
      </div>
      <div className="prose prose-slate max-w-none text-slate-600 leading-relaxed bg-slate-50/50 p-6 rounded-2xl border border-slate-50">
        {content ? (
          <ReactMarkdown>{content}</ReactMarkdown>
        ) : (
          <p className="text-slate-400 italic">No transcription available for this manuscript.</p>
        )}
      </div>
    </div>
  );
}

function EntityGroup({ icon, label, items }: { icon: React.ReactNode, label: string, items: string[] }) {
  return (
    <div>
      <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3 flex items-center gap-2">
        {icon}
        {label}
      </p>
      <div className="flex flex-wrap gap-2">
        {items && items.length > 0 ? (
          items.map(item => (
            <span key={item} className="px-3 py-1.5 bg-slate-50 border border-slate-100 text-slate-700 text-sm rounded-xl font-medium">
              {item}
            </span>
          ))
        ) : (
          <span className="text-xs text-slate-400 italic">No {label.toLowerCase()} identified</span>
        )}
      </div>
    </div>
  );
}
