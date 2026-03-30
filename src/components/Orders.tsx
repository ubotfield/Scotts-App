import React from 'react';
import { motion } from 'motion/react';
import { Mic, ReceiptText, AudioLines, ChevronRight } from 'lucide-react';

export const Orders: React.FC = () => {
  return (
    <div className="space-y-10">
      <section className="space-y-2">
        <h2 className="font-headline text-4xl font-extrabold tracking-tight">Orders</h2>
        <p className="text-on-surface/70 font-medium">Track and manage your orders.</p>
      </section>

      {/* Voice ordering prompt */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-primary-container rounded-2xl p-8 text-center space-y-6"
      >
        <div className="w-20 h-20 bg-primary/10 rounded-full flex items-center justify-center mx-auto">
          <AudioLines size={40} className="text-primary" />
        </div>
        <div className="space-y-2">
          <h3 className="font-headline text-2xl font-black text-on-surface">Order with Your Voice</h3>
          <p className="text-on-surface/70 font-medium max-w-md mx-auto">
            Use our AI voice assistant to place orders, check loyalty points, and track your meals — all hands-free.
            Tap the mic button to get started.
          </p>
        </div>
      </motion.div>

      {/* Suggestions */}
      <div className="space-y-4">
        <h3 className="font-headline text-xl font-bold text-on-surface/60 uppercase tracking-widest text-center">Try saying...</h3>
        {[
          "Show me the menu",
          "I'd like a Classic Fresh Burger with bacon",
          "Can I get a Grilled Chicken Bowl?",
          "Check my loyalty points",
        ].map((suggestion, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.1 }}
            className="bg-surface-container-high rounded-xl p-5 border border-primary/5 flex items-center gap-4"
          >
            <div className="w-8 h-8 bg-primary/10 rounded-full flex items-center justify-center flex-shrink-0">
              <Mic size={16} className="text-primary" />
            </div>
            <span className="text-on-surface font-medium italic">"{suggestion}"</span>
          </motion.div>
        ))}
      </div>

      <div className="mt-12 text-center p-8 border-2 border-dashed border-primary/20 rounded-xl">
        <ReceiptText size={32} className="mx-auto text-on-surface/30 mb-3" />
        <p className="text-on-surface/60 font-medium italic">"Your order history will appear here after your first order."</p>
      </div>
    </div>
  );
};
