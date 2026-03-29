import React from 'react';
import { motion } from 'motion/react';
import { History, AudioLines, ChevronRight, Mic } from 'lucide-react';

const ORDERS = [
  {
    id: 1,
    date: "Oct 24, 2023 • 12:45 PM",
    title: "Spicy Umami Bowl & Matcha",
    price: 24.50,
    items: 2,
    status: "Delivered to Home",
    favorite: true
  },
  {
    id: 2,
    date: "Oct 18, 2023 • 7:20 PM",
    title: "Double Smashburger",
    price: 18.90,
    items: 1,
    status: "Delivered to Office"
  }
];

export const Orders: React.FC = () => {
  return (
    <div className="space-y-10">
      <section className="space-y-2">
        <h2 className="font-headline text-4xl font-extrabold tracking-tight">Orders</h2>
        <p className="text-on-surface/70 font-medium">Relive your delicious moments.</p>
      </section>

      <div className="space-y-6">
        {ORDERS.map((order) => (
          <motion.div 
            key={order.id}
            whileHover={{ scale: 1.01 }}
            className="bg-surface-container-high rounded-xl p-6 relative overflow-hidden border border-primary/5"
          >
            <div className="flex justify-between items-start mb-4">
              <div>
                <span className="font-headline text-xs font-bold uppercase tracking-widest text-primary mb-1 block">{order.date}</span>
                <h3 className="font-headline text-xl font-bold">{order.title}</h3>
              </div>
              <span className="font-headline font-black text-xl">${order.price.toFixed(2)}</span>
            </div>
            
            <div className="flex gap-4 mb-6">
              <div className="text-sm text-on-surface/70 font-medium">{order.items} items • {order.status}</div>
            </div>

            <button className="w-full bg-primary text-on-primary font-headline font-bold py-4 rounded-full flex items-center justify-center gap-3 transition-all hover:brightness-110">
              <AudioLines size={20} fill="currentColor" />
              <span>Quick Re-order with Voice</span>
              <ChevronRight size={18} />
            </button>

            {order.favorite && (
              <div className="absolute -top-2 -right-2 bg-secondary-container text-on-secondary-container font-headline text-[10px] font-black px-3 py-1 rounded-full rotate-12 shadow-sm uppercase tracking-tighter">
                Favorite
              </div>
            )}
          </motion.div>
        ))}
      </div>

      <div className="mt-12 text-center p-8 border-2 border-dashed border-primary/20 rounded-xl">
        <p className="text-on-surface/60 font-medium italic">"The secret ingredient is always a repeat order."</p>
      </div>
    </div>
  );
};
