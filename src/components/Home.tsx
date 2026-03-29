import React from 'react';
import { motion } from 'motion/react';
import { ArrowRight, Heart, Sparkles, Tag, ReceiptText } from 'lucide-react';

interface HomeProps {
  onNavigate: (tab: 'home' | 'menu' | 'orders' | 'profile') => void;
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good Morning';
  if (hour < 17) return 'Good Afternoon';
  return 'Good Evening';
}

export const Home: React.FC<HomeProps> = ({ onNavigate }) => {
  return (
    <div className="space-y-12">
      <section className="text-center space-y-4 py-8">
        <span className="font-headline text-xs uppercase tracking-[0.2em] text-primary font-bold">{getGreeting()}, Explorer</span>
        <h2 className="font-headline text-5xl md:text-7xl font-extrabold tracking-tight text-on-surface leading-tight">
          Ready for Your<br />
          <span className="text-primary italic">Next Meal?</span>
        </h2>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <motion.div
          whileHover={{ scale: 1.02 }}
          onClick={() => onNavigate('menu')}
          className="md:col-span-2 bg-surface-container-low rounded-xl p-10 flex flex-col md:flex-row justify-between items-center relative overflow-hidden min-h-[260px] border border-on-surface/5 cursor-pointer"
        >
          <div className="relative z-10 w-full md:w-1/2 space-y-4">
            <h3 className="font-headline text-3xl font-black uppercase tracking-tight">Start New Order</h3>
            <p className="text-on-surface/70 font-bold">Fresh burgers, grilled steaks, bowls, and more — made to order.</p>
            <div className="flex items-center gap-2 font-headline font-bold text-primary uppercase tracking-widest text-sm">
              <span>Browse Menu</span>
              <ArrowRight size={18} />
            </div>
          </div>
          <div className="relative w-48 h-48 md:w-64 md:h-64 mt-6 md:mt-0 flex-shrink-0">
            <img
              className="w-full h-full object-cover rounded-full shadow-lg"
              src="https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&q=80&w=500"
              alt="Healthy Bowl"
            />
          </div>
        </motion.div>

        <motion.div
          whileHover={{ scale: 1.02 }}
          className="bg-secondary-container rounded-xl p-8 flex flex-col justify-between border border-black/5 cursor-pointer"
        >
          <div className="w-12 h-12 bg-white/20 rounded-full flex items-center justify-center mb-4">
            <Heart className="text-on-secondary-container fill-current" />
          </div>
          <div>
            <h3 className="font-headline text-2xl font-black text-on-secondary-container uppercase tracking-tight">My Favorites</h3>
            <p className="text-on-secondary-container/80 text-sm mt-1 font-bold">Quick reorder your picks.</p>
          </div>
        </motion.div>

        <motion.div
          whileHover={{ scale: 1.02 }}
          className="bg-primary-container rounded-xl p-6 flex flex-col justify-between border border-black/5 cursor-pointer"
        >
          <Sparkles className="text-on-surface" />
          <h4 className="font-headline text-lg font-black text-on-surface mt-4 uppercase tracking-tight">Dietary Prefs</h4>
        </motion.div>

        <motion.div
          whileHover={{ scale: 1.02 }}
          className="bg-tertiary rounded-xl p-6 flex items-center justify-between relative overflow-hidden border border-black/5 cursor-pointer"
        >
          <div className="relative z-10">
            <h4 className="font-headline text-lg font-black text-on-surface uppercase tracking-tight">Today's Deals</h4>
            <span className="text-on-surface/70 text-sm font-bold">3 Active Offers</span>
          </div>
          <Tag className="text-on-surface relative z-10" />
          <div className="absolute top-0 right-0 w-16 h-16 bg-white/20 rounded-full -mr-8 -mt-8" />
        </motion.div>

        <motion.div
          whileHover={{ scale: 1.02 }}
          onClick={() => onNavigate('orders')}
          className="bg-surface-container-highest rounded-xl p-6 flex items-center justify-between border border-on-surface/5 cursor-pointer"
        >
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-on-surface/5 rounded-full flex items-center justify-center">
              <ReceiptText size={20} />
            </div>
            <h4 className="font-headline text-lg font-black uppercase tracking-tight">Track Orders</h4>
          </div>
          <ArrowRight className="text-primary" size={20} />
        </motion.div>
      </div>
    </div>
  );
};
