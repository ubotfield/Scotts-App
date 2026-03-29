import React from 'react';
import { User, Settings, CreditCard, ShieldCheck, LogOut, Mic, Star } from 'lucide-react';

export const Profile: React.FC = () => {
  return (
    <div className="space-y-10">
      <section className="flex items-center gap-6 p-4">
        <div className="w-24 h-24 rounded-full bg-primary-container overflow-hidden border-4 border-primary/20">
          <img
            src="https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?auto=format&fit=crop&q=80&w=200"
            alt="User"
            className="w-full h-full object-cover"
          />
        </div>
        <div>
          <h2 className="font-headline text-3xl font-black text-primary">Welcome Back</h2>
          <p className="text-xs text-on-surface/60 font-bold uppercase tracking-widest">Fresh Kitchen Member</p>
        </div>
      </section>

      {/* Loyalty card */}
      <div className="bg-gradient-to-br from-primary to-primary-dim rounded-2xl p-6 text-on-primary space-y-4">
        <div className="flex items-center gap-3">
          <Star size={24} fill="currentColor" />
          <span className="font-headline font-black text-lg uppercase tracking-wide">Fresh Rewards</span>
        </div>
        <p className="text-on-primary/80 text-sm font-medium">
          Use voice to check your loyalty points, redeem rewards, or link your phone number to your account.
        </p>
        <div className="flex items-center gap-2 bg-white/20 rounded-full px-4 py-2 w-fit">
          <Mic size={16} fill="currentColor" />
          <span className="text-sm font-bold">Say "Check my loyalty points"</span>
        </div>
      </div>

      <nav className="space-y-2">
        {[
          { icon: User, label: "Personal Info" },
          { icon: CreditCard, label: "Payment Methods" },
          { icon: ShieldCheck, label: "Privacy & Security" },
          { icon: Settings, label: "App Settings" },
        ].map((item, i) => (
          <button
            key={i}
            className="w-full flex items-center gap-4 px-6 py-5 text-on-surface hover:bg-surface-container-high rounded-xl transition-all font-headline font-semibold text-lg text-left"
          >
            <item.icon size={24} className="text-primary" />
            <span>{item.label}</span>
          </button>
        ))}

        <button className="w-full flex items-center gap-4 px-6 py-5 text-primary hover:bg-primary/5 rounded-xl transition-all font-headline font-semibold text-lg text-left mt-8">
          <LogOut size={24} />
          <span>Sign Out</span>
        </button>
      </nav>
    </div>
  );
};
