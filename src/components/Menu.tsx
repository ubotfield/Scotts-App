import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Mic, AlertTriangle, Loader2 } from 'lucide-react';

interface MenuItem {
  id: string;
  name: string;
  price: number;
  description: string;
  category: string;
  calories?: number;
  available?: boolean;
}

interface MenuProps {
  onStartVoice: () => void;
}

// Category → Unsplash image map
const CATEGORY_IMAGES: Record<string, string> = {
  Burgers: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&q=80&w=400',
  Wraps: 'https://images.unsplash.com/photo-1626700051175-6818013e1d4f?auto=format&fit=crop&q=80&w=400',
  Bowls: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?auto=format&fit=crop&q=80&w=400',
  Entrees: 'https://images.unsplash.com/photo-1467003909585-2f8a72700288?auto=format&fit=crop&q=80&w=400',
  Salads: 'https://images.unsplash.com/photo-1540420773420-3366772f4999?auto=format&fit=crop&q=80&w=400',
  Beverages: 'https://images.unsplash.com/photo-1513558161293-cdaf765ed2fd?auto=format&fit=crop&q=80&w=400',
  Sides: 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?auto=format&fit=crop&q=80&w=400',
  Desserts: 'https://images.unsplash.com/photo-1551024601-bec78aea704b?auto=format&fit=crop&q=80&w=400',
};
const DEFAULT_IMAGE = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&q=80&w=400';

export const Menu: React.FC<MenuProps> = ({ onStartVoice }) => {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<string>('');

  useEffect(() => {
    fetchMenu();
  }, []);

  const fetchMenu = async () => {
    try {
      const res = await fetch('/api/menu');
      if (res.ok) {
        const data = await res.json();
        setItems(data.items || []);
        setSource(data.source || 'unknown');
      }
    } catch (err) {
      console.error('Failed to fetch menu:', err);
    } finally {
      setLoading(false);
    }
  };

  // Group items by category
  const grouped: Record<string, MenuItem[]> = {};
  for (const item of items) {
    const cat = item.category || 'Other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(item);
  }

  const subtotal = items.reduce((sum, item) => sum + (item.price || 0), 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={32} className="animate-spin text-primary" />
        <span className="ml-3 font-headline font-bold text-on-surface/60">Loading menu...</span>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <section className="text-center space-y-4">
        <h2 className="font-headline text-4xl font-extrabold tracking-tight text-on-surface">Our Fresh Menu</h2>
        <p className="text-on-surface/70 font-medium">Browse our selection or use voice to order and customize.</p>
      </section>

      {Object.entries(grouped).map(([category, categoryItems]) => (
        <div key={category} className="space-y-4">
          <h3 className="font-headline text-2xl font-black uppercase tracking-tight text-primary">{category}</h3>
          <div className="space-y-4">
            {categoryItems.map((item) => (
              <motion.div
                key={item.id}
                whileHover={{ y: -4 }}
                className="bg-surface-container-low rounded-xl p-6 border border-primary/5 shadow-sm"
              >
                <div className="flex flex-col md:flex-row gap-6">
                  <div className="w-full md:w-32 h-32 rounded-lg overflow-hidden flex-shrink-0">
                    <img
                      src={CATEGORY_IMAGES[category] || DEFAULT_IMAGE}
                      alt={item.name}
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="flex-grow space-y-3">
                    <div className="flex justify-between items-start">
                      <h3 className="font-headline text-xl font-bold">{item.name}</h3>
                      <span className="font-headline font-extrabold text-primary">${item.price?.toFixed(2)}</span>
                    </div>
                    <p className="text-sm text-on-surface/80 leading-relaxed">{item.description}</p>

                    <div className="flex flex-wrap gap-3 items-center">
                      <button
                        onClick={onStartVoice}
                        className="flex items-center gap-2 bg-primary px-5 py-2.5 rounded-full text-on-primary font-bold text-sm shadow-lg shadow-primary/20 hover:brightness-110 transition-all"
                      >
                        <Mic size={16} fill="currentColor" />
                        Order with Voice
                      </button>
                      {item.calories && (
                        <span className="text-xs font-headline font-bold uppercase text-on-surface/50 bg-surface-container-highest px-3 py-1.5 rounded-full">
                          {item.calories} cal
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      ))}

      {/* Order Summary */}
      <section className="bg-surface-container-highest/30 rounded-xl p-8 border border-primary/10 space-y-6">
        <div className="space-y-3">
          <div className="flex justify-between text-on-surface/70 font-medium">
            <span>{items.length} menu items available</span>
          </div>
          <div className="h-px bg-on-surface/10 my-4" />
          <div className="flex justify-between items-baseline">
            <span className="font-headline text-lg font-black">Ready to order?</span>
          </div>
        </div>
        <button
          onClick={onStartVoice}
          className="w-full bg-gradient-to-br from-primary-dim to-primary text-on-primary py-5 rounded-xl font-headline text-lg font-extrabold tracking-wide shadow-xl shadow-primary/25 hover:opacity-90 transition-all flex items-center justify-center gap-3"
        >
          <Mic size={24} fill="currentColor" />
          Start Voice Order
        </button>
      </section>
    </div>
  );
};
