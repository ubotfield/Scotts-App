import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Loader2, Flame } from 'lucide-react';

interface MenuItem {
  id: string;
  name: string;
  price: number;
  description: string;
  category: string;
  calories?: number;
  isPopular?: boolean;
  available?: boolean;
}

// Category → Unsplash image map (matching Scott's Fresh Kitchens real categories)
const CATEGORY_IMAGES: Record<string, string> = {
  'Burgers': 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&q=80&w=400',
  'Steaks & Grills': 'https://images.unsplash.com/photo-1544025162-d76694265947?auto=format&fit=crop&q=80&w=400',
  'Pasta & Bowls': 'https://images.unsplash.com/photo-1473093295043-cdd812d0e601?auto=format&fit=crop&q=80&w=400',
  'Sides': 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?auto=format&fit=crop&q=80&w=400',
  'Fresh Juices & Drinks': 'https://images.unsplash.com/photo-1622597467836-f3285f2131b8?auto=format&fit=crop&q=80&w=400',
  'Desserts': 'https://images.unsplash.com/photo-1551024601-bec78aea704b?auto=format&fit=crop&q=80&w=400',
};

// Per-item image overrides for hero items
const ITEM_IMAGES: Record<string, string> = {
  'Classic Fresh Burger': 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&q=80&w=400',
  'Crispy Chicken Sandwich': 'https://images.unsplash.com/photo-1606755962773-d324e0a13086?auto=format&fit=crop&q=80&w=400',
  'Double Stack Burger': 'https://images.unsplash.com/photo-1553979459-d2229ba7433b?auto=format&fit=crop&q=80&w=400',
  'Veggie Garden Burger': 'https://images.unsplash.com/photo-1525059696034-4967a8e1dca2?auto=format&fit=crop&q=80&w=400',
  'Grilled Filet Mignon': 'https://images.unsplash.com/photo-1558030006-450675393462?auto=format&fit=crop&q=80&w=400',
  'Herb-Crusted Ribeye': 'https://images.unsplash.com/photo-1544025162-d76694265947?auto=format&fit=crop&q=80&w=400',
  'BBQ Grilled Chicken': 'https://images.unsplash.com/photo-1532550907401-a500c9a57435?auto=format&fit=crop&q=80&w=400',
  'Carbonara': 'https://images.unsplash.com/photo-1612874742237-6526221588e3?auto=format&fit=crop&q=80&w=400',
  'Grilled Chicken Bowl': 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?auto=format&fit=crop&q=80&w=400',
  'Penne Arrabbiata': 'https://images.unsplash.com/photo-1563379926898-05f4575a45d8?auto=format&fit=crop&q=80&w=400',
  'Fresh-Cut Fries': 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?auto=format&fit=crop&q=80&w=400',
  'Sweet Potato Fries': 'https://images.unsplash.com/photo-1604152135912-04a022e23696?auto=format&fit=crop&q=80&w=400',
  'Onion Rings': 'https://images.unsplash.com/photo-1639024471283-03518883512d?auto=format&fit=crop&q=80&w=400',
  'Garden Salad': 'https://images.unsplash.com/photo-1540420773420-3366772f4999?auto=format&fit=crop&q=80&w=400',
  'Fresh Lemonade': 'https://images.unsplash.com/photo-1621263764928-df1444c5e859?auto=format&fit=crop&q=80&w=400',
  'Tropical Mango Smoothie': 'https://images.unsplash.com/photo-1623065422902-30a2d299bbe4?auto=format&fit=crop&q=80&w=400',
  'Berry Blast Smoothie': 'https://images.unsplash.com/photo-1553530666-ba11a7da3888?auto=format&fit=crop&q=80&w=400',
  'Green Detox Juice': 'https://images.unsplash.com/photo-1610970881699-44a5587cabec?auto=format&fit=crop&q=80&w=400',
  'Chocolate Brownie': 'https://images.unsplash.com/photo-1606313564200-e75d5e30476c?auto=format&fit=crop&q=80&w=400',
  'Fresh Fruit Cup': 'https://images.unsplash.com/photo-1490474418585-ba9bad8fd0ea?auto=format&fit=crop&q=80&w=400',
};

const DEFAULT_IMAGE = 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&q=80&w=400';

function getItemImage(item: MenuItem): string {
  return ITEM_IMAGES[item.name] || CATEGORY_IMAGES[item.category] || DEFAULT_IMAGE;
}

export const Menu: React.FC = () => {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMenu();
  }, []);

  const fetchMenu = async () => {
    try {
      const { apiUrl } = await import('../lib/api-base');
      const res = await fetch(apiUrl('/api/menu'));
      if (res.ok) {
        const data = await res.json();
        setItems(data.items || []);
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

  // Order categories in a sensible way
  const categoryOrder = ['Burgers', 'Steaks & Grills', 'Pasta & Bowls', 'Sides', 'Fresh Juices & Drinks', 'Desserts'];
  const sortedCategories = Object.keys(grouped).sort((a, b) => {
    const ai = categoryOrder.indexOf(a);
    const bi = categoryOrder.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

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
        <p className="text-on-surface/70 font-medium">Fresh, feel-good food made to order. Tap the mic to order with your voice.</p>
      </section>

      {sortedCategories.map((category) => (
        <div key={category} className="space-y-4">
          <h3 className="font-headline text-2xl font-black uppercase tracking-tight text-primary">{category}</h3>
          <div className="space-y-4">
            {grouped[category].map((item) => (
              <motion.div
                key={item.id}
                whileHover={{ y: -4 }}
                className="bg-surface-container-low rounded-xl p-6 border border-primary/5 shadow-sm"
              >
                <div className="flex flex-col md:flex-row gap-6">
                  <div className="w-full md:w-32 h-32 rounded-lg overflow-hidden flex-shrink-0 relative">
                    <img
                      src={getItemImage(item)}
                      alt={item.name}
                      className="w-full h-full object-cover"
                    />
                    {item.isPopular && (
                      <div className="absolute top-2 left-2 bg-primary text-on-primary text-[10px] font-black uppercase px-2 py-0.5 rounded-full flex items-center gap-1">
                        <Flame size={10} fill="currentColor" />
                        Popular
                      </div>
                    )}
                  </div>
                  <div className="flex-grow space-y-3">
                    <div className="flex justify-between items-start">
                      <h3 className="font-headline text-xl font-bold">{item.name}</h3>
                      <span className="font-headline font-extrabold text-primary">${item.price?.toFixed(2)}</span>
                    </div>
                    <p className="text-sm text-on-surface/80 leading-relaxed">{item.description}</p>

                    <div className="flex flex-wrap gap-3 items-center">
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

      {/* Order CTA */}
      <section className="bg-surface-container-highest/30 rounded-xl p-8 border border-primary/10 space-y-6">
        <div className="text-center space-y-2">
          <h3 className="font-headline text-2xl font-black">Ready to Order?</h3>
          <p className="text-on-surface/60 font-medium">Tap the mic button to tell our voice assistant what you'd like — customize anything on the menu.</p>
        </div>
      </section>
    </div>
  );
};
