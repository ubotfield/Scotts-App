import React from 'react';
import { motion } from 'motion/react';
import { Mic, AlertTriangle } from 'lucide-react';

const MENU_ITEMS = [
  {
    id: 1,
    name: "Kinetic Signature Burger",
    price: 18.50,
    description: "Double wagyu beef, aged cheddar, balsamic onions, brioche bun.",
    image: "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&q=80&w=500",
    customization: "Medium Rare"
  },
  {
    id: 2,
    name: "Zen Harvest Bowl",
    price: 14.20,
    description: "Quinoa base, roasted chickpeas, kale, tahini dressing, micro-greens.",
    image: "https://images.unsplash.com/photo-1512621776951-a57141f2eefd?auto=format&fit=crop&q=80&w=500",
    warning: "No Peanuts"
  },
  {
    id: 3,
    name: "Electric Passion Spritz",
    price: 6.00,
    description: "Sparkling mineral water, fresh passion fruit pulp, mint sprig.",
    image: "https://images.unsplash.com/photo-1513558161293-cdaf765ed2fd?auto=format&fit=crop&q=80&w=500"
  }
];

export const Menu: React.FC = () => {
  return (
    <div className="space-y-10">
      <section className="text-center space-y-4">
        <h2 className="font-headline text-4xl font-extrabold tracking-tight text-on-surface">Your Fresh Selection</h2>
        <p className="text-on-surface/70 font-medium">Review your items or use voice to customize each plate perfectly.</p>
      </section>

      <div className="space-y-6">
        {MENU_ITEMS.map((item) => (
          <motion.div 
            key={item.id}
            whileHover={{ y: -4 }}
            className="bg-surface-container-low rounded-xl p-6 border border-primary/5 shadow-sm"
          >
            <div className="flex flex-col md:flex-row gap-6">
              <div className="w-full md:w-32 h-32 rounded-lg overflow-hidden flex-shrink-0">
                <img src={item.image} alt={item.name} className="w-full h-full object-cover" />
              </div>
              <div className="flex-grow space-y-3">
                <div className="flex justify-between items-start">
                  <h3 className="font-headline text-xl font-bold">{item.name}</h3>
                  <span className="font-headline font-extrabold text-primary">${item.price.toFixed(2)}</span>
                </div>
                <p className="text-sm text-on-surface/80 leading-relaxed">{item.description}</p>
                
                <div className="flex flex-wrap gap-3">
                  <button className="flex items-center gap-2 bg-primary px-5 py-2.5 rounded-full text-on-primary font-bold text-sm shadow-lg shadow-primary/20 hover:brightness-110 transition-all">
                    <Mic size={16} fill="currentColor" />
                    Edit with Voice
                  </button>
                  {item.customization && (
                    <div className="flex items-center gap-2 bg-surface-container-highest px-4 py-2 rounded-full border border-primary/10">
                      <span className="text-xs font-headline font-bold uppercase text-on-surface/60">Current:</span>
                      <span className="text-sm font-semibold">{item.customization}</span>
                    </div>
                  )}
                  {item.warning && (
                    <div className="flex items-center gap-2 bg-surface-container-highest px-4 py-2 rounded-full border border-primary/10">
                      <AlertTriangle size={14} className="text-primary" />
                      <span className="text-sm font-semibold">{item.warning}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      <section className="bg-surface-container-highest/30 rounded-xl p-8 border border-primary/10 space-y-6">
        <div className="space-y-3">
          <div className="flex justify-between text-on-surface/70 font-medium">
            <span>Subtotal</span>
            <span className="font-headline font-bold">$38.70</span>
          </div>
          <div className="flex justify-between text-on-surface/70 font-medium">
            <span>Delivery Fee</span>
            <span className="font-headline font-bold text-tertiary">$2.50</span>
          </div>
          <div className="h-px bg-on-surface/10 my-4" />
          <div className="flex justify-between items-baseline">
            <span className="font-headline text-2xl font-black">Total</span>
            <span className="font-headline text-3xl font-black text-primary">$41.20</span>
          </div>
        </div>
        <button className="w-full bg-gradient-to-br from-primary-dim to-primary text-on-primary py-5 rounded-xl font-headline text-lg font-extrabold tracking-wide shadow-xl shadow-primary/25 hover:opacity-90 transition-all">
          Proceed to Checkout
        </button>
      </section>
    </div>
  );
};
