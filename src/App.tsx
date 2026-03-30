import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Home as HomeIcon, UtensilsCrossed, ReceiptText, User, Menu as MenuIcon } from 'lucide-react';
import { Home } from './components/Home';
import { Menu } from './components/Menu';
import { Orders } from './components/Orders';
import { Profile } from './components/Profile';
import { VoiceAssistant } from './components/VoiceAssistant';

type Tab = 'home' | 'menu' | 'orders' | 'profile';

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('home');

  const renderContent = () => {
    switch (activeTab) {
      case 'home': return <Home onNavigate={(tab: Tab) => setActiveTab(tab)} />;
      case 'menu': return <Menu />;
      case 'orders': return <Orders />;
      case 'profile': return <Profile />;
    }
  };

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      {/* Top App Bar */}
      <header className="bg-surface flex justify-between items-center w-full px-6 py-4 fixed top-0 z-50" style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}>
        <div className="flex items-center gap-4">
          <button className="text-primary hover:opacity-80 transition-opacity">
            <MenuIcon size={24} />
          </button>
          <h1 className="font-headline font-bold text-2xl tracking-tight text-primary italic">Scott's Kitchen</h1>
        </div>
        <div className="w-10 h-10 rounded-full bg-surface-container-high overflow-hidden border-2 border-primary">
          <img
            alt="User"
            className="w-full h-full object-cover"
            src="https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&q=80&w=100"
          />
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-grow pt-28 pb-32 px-6 max-w-5xl mx-auto w-full">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.2 }}
          >
            {renderContent()}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Voice Assistant — self-contained: mic button + inline popup bar */}
      <VoiceAssistant />

      {/* Bottom Navigation */}
      <nav className="fixed bottom-0 left-0 w-full z-50 flex justify-around items-center px-4 pb-8 pt-4 bg-surface rounded-t-xl shadow-[0_-4px_24px_rgba(44,37,37,0.08)]">
        {[
          { id: 'home', icon: HomeIcon, label: 'Home' },
          { id: 'menu', icon: UtensilsCrossed, label: 'Menu' },
          { id: 'orders', icon: ReceiptText, label: 'Orders' },
          { id: 'profile', icon: User, label: 'Profile' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as Tab)}
            className={`flex flex-col items-center justify-center px-5 py-2 rounded-full transition-all duration-300 ${
              activeTab === tab.id
                ? 'bg-primary text-on-primary scale-110'
                : 'text-on-surface opacity-60 hover:bg-on-surface/5'
            }`}
          >
            <tab.icon size={24} fill={activeTab === tab.id ? "currentColor" : "none"} />
            <span className="font-headline font-bold text-[10px] uppercase tracking-widest mt-1">
              {tab.label}
            </span>
          </button>
        ))}
      </nav>
    </div>
  );
}
