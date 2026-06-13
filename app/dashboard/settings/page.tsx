"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { WalletConnection } from "@/app/components/WalletConnection";

export default function SettingsPage() {
  const router = useRouter();
  const [activeSection, setActiveSection] = useState<"profile" | "security" | "notifications" | "preferences" | "wallet">("profile");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  // Profile state
  const [profileData, setProfileData] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    country: "",
    timezone: "America/New_York",
  });

  // Fetch user data on mount
  useEffect(() => {
    async function loadUserData() {
      // Check if Supabase is configured
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      if (!supabaseUrl || !supabaseKey || supabaseUrl.includes('YOUR_') || supabaseKey.length < 100) {
        // Supabase not configured - use demo data
        setProfileData({
          firstName: "Demo",
          lastName: "User",
          email: "demo@goldenfleece.com",
          phone: "",
          country: "United States",
          timezone: "America/New_York",
        });
        setLoading(false);
        return;
      }

      try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();

        if (!user) {
          // No user logged in - use guest data
          setProfileData({
            firstName: "Guest",
            lastName: "User",
            email: "",
            phone: "",
            country: "",
            timezone: "America/New_York",
          });
          setLoading(false);
          return;
        }

        // Fetch profile data
        const { data: profile, error } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', user.id)
          .single();

        if (error) throw error;

        if (profile) {
          setProfileData({
            firstName: profile.first_name || "",
            lastName: profile.last_name || "",
            email: profile.email || user.email || "",
            phone: profile.phone || "",
            country: profile.country || "",
            timezone: profile.timezone || "America/New_York",
          });
        }
      } catch (error) {
        // Silently handle errors - don't spam console
        setProfileData({
          firstName: "Guest",
          lastName: "",
          email: "",
          phone: "",
          country: "",
          timezone: "America/New_York",
        });
      } finally {
        setLoading(false);
      }
    }

    loadUserData();
  }, [router]);

  // Security state
  const [securityData, setSecurityData] = useState({
    twoFactorEnabled: true,
    biometricEnabled: false,
  });

  
  // Notification state
  const [notificationSettings, setNotificationSettings] = useState({
    emailNotifications: true,
    investmentUpdates: true,
    dividendPayments: true,
    projectUpdates: false,
    marketingEmails: false,
    smsNotifications: false,
  });

  // Preference state
  const [preferences, setPreferences] = useState({
    currency: "USD",
    language: "English",
    theme: "dark",
  });

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);

    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();

      if (!user) {
        router.push('/login');
        return;
      }

      const { error: profileError } = await supabase
        .from('profiles')
        .update({
          first_name: profileData.firstName,
          last_name: profileData.lastName,
          phone: profileData.phone,
          country: profileData.country,
          timezone: profileData.timezone,
        })
        .eq('id', user.id);

      if (profileError) throw profileError;

      // Sync the user_metadata to ensure session auth data matches
      const { error: authError } = await supabase.auth.updateUser({
        data: {
          first_name: profileData.firstName,
          last_name: profileData.lastName,
          phone: profileData.phone,
        }
      });

      if (authError) {
        console.warn('Non-critical: Failed to sync auth user metadata', authError);
      }

      setMessage({ type: 'success', text: 'Profile updated successfully!' });
    } catch (error: any) {
      console.error('Error saving profile:', error);
      setMessage({ type: 'error', text: error.message || 'Failed to save profile' });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSecurity = (e: React.FormEvent) => {
    e.preventDefault();
    console.log("Saving security:", securityData);
  };

  const handleSaveNotifications = (e: React.FormEvent) => {
    e.preventDefault();
    console.log("Saving notifications:", notificationSettings);
  };

  const handleSavePreferences = (e: React.FormEvent) => {
    e.preventDefault();
    console.log("Saving preferences:", preferences);
  };

  const sections = [
    { id: "profile" as const, label: "Profile", icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
      </svg>
    )},
    { id: "wallet" as const, label: "Crypto Wallet", icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
      </svg>
    )},
    { id: "security" as const, label: "Security", icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
      </svg>
    )},
    { id: "notifications" as const, label: "Notifications", icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
      </svg>
    )},
    { id: "preferences" as const, label: "Preferences", icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
      </svg>
    )},
  ];

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold text-white mb-2">Settings</h1>
        <p className="text-gray-400">Manage your account settings and preferences</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Sidebar Navigation */}
        <div className="lg:col-span-1">
          <div className="glass rounded-xl border border-gold/20 overflow-hidden">
            <nav className="space-y-1 p-2">
              {sections.map((section) => (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all ${
                    activeSection === section.id
                      ? "bg-gold/10 text-gold"
                      : "text-gray-400 hover:bg-gold/5 hover:text-white"
                  }`}
                >
                  {section.icon}
                  <span className="text-sm font-medium">{section.label}</span>
                </button>
              ))}
            </nav>
          </div>
        </div>

        {/* Main Content */}
        <div className="lg:col-span-3">
          {/* Profile Section */}
          {activeSection === "profile" && (
            <div className="glass rounded-xl p-6 border border-gold/20">
              <h2 className="text-xl font-bold text-white mb-6">Profile Information</h2>
              <form onSubmit={handleSaveProfile} className="space-y-6">
                {/* Profile Picture */}
                <div className="flex items-center gap-6">
                  <div className="w-24 h-24 bg-gold/20 rounded-full flex items-center justify-center">
                    <svg className="w-12 h-12 text-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                  </div>
                  <div>
                    <button
                      type="button"
                      className="px-4 py-2 bg-gold/10 hover:bg-gold/20 border border-gold/20 rounded-lg text-sm font-medium text-white transition-all"
                    >
                      Upload Photo
                    </button>
                    <p className="text-xs text-gray-400 mt-2">JPG, PNG or GIF. Max size 2MB.</p>
                  </div>
                </div>

                {/* Name Fields */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-400 mb-2">
                      First Name
                    </label>
                    <input
                      type="text"
                      value={profileData.firstName}
                      onChange={(e) => setProfileData({ ...profileData, firstName: e.target.value })}
                      className="w-full bg-navy-dark text-white border border-gold/20 rounded-lg px-4 py-3 focus:outline-none focus:border-gold"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-400 mb-2">
                      Last Name
                    </label>
                    <input
                      type="text"
                      value={profileData.lastName}
                      onChange={(e) => setProfileData({ ...profileData, lastName: e.target.value })}
                      className="w-full bg-navy-dark text-white border border-gold/20 rounded-lg px-4 py-3 focus:outline-none focus:border-gold"
                    />
                  </div>
                </div>

                {/* Email */}
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-2">
                    Email Address
                  </label>
                  <input
                    type="email"
                    value={profileData.email}
                    onChange={(e) => setProfileData({ ...profileData, email: e.target.value })}
                    className="w-full bg-navy-dark text-white border border-gold/20 rounded-lg px-4 py-3 focus:outline-none focus:border-gold"
                  />
                </div>

                {/* Phone */}
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-2">
                    Phone Number
                  </label>
                  <input
                    type="tel"
                    value={profileData.phone}
                    onChange={(e) => setProfileData({ ...profileData, phone: e.target.value })}
                    className="w-full bg-navy-dark text-white border border-gold/20 rounded-lg px-4 py-3 focus:outline-none focus:border-gold"
                  />
                </div>

                {/* Country & Timezone */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-400 mb-2">
                      Country
                    </label>
                    <select
                      value={profileData.country}
                      onChange={(e) => setProfileData({ ...profileData, country: e.target.value })}
                      className="w-full bg-navy-dark text-white border border-gold/20 rounded-lg px-4 py-3 focus:outline-none focus:border-gold"
                    >
                      <option>United States</option>
                      <option>United Kingdom</option>
                      <option>Canada</option>
                      <option>Australia</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-400 mb-2">
                      Timezone
                    </label>
                    <select
                      value={profileData.timezone}
                      onChange={(e) => setProfileData({ ...profileData, timezone: e.target.value })}
                      className="w-full bg-navy-dark text-white border border-gold/20 rounded-lg px-4 py-3 focus:outline-none focus:border-gold"
                    >
                      <option>America/New_York</option>
                      <option>America/Los_Angeles</option>
                      <option>Europe/London</option>
                      <option>Asia/Tokyo</option>
                    </select>
                  </div>
                </div>

                {/* Success/Error Message */}
                {message && (
                  <div className={`p-4 rounded-lg ${message.type === 'success' ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
                    {message.text}
                  </div>
                )}

                {/* Save Button */}
                <button
                  type="submit"
                  disabled={saving || loading}
                  className="w-full md:w-auto px-6 py-3 bg-gradient-to-r from-gold to-gold-light text-navy font-bold rounded-lg hover:scale-105 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              </form>
            </div>
          )}

          {/* Wallet Section */}
          {activeSection === "wallet" && (
            <div className="glass rounded-xl p-6 border border-gold/20">
              <WalletConnection />
            </div>
          )}

          {/* Security Section */}
          {activeSection === "security" && (
            <div className="space-y-6">
              <div className="glass rounded-xl p-6 border border-gold/20">
                <h2 className="text-xl font-bold text-white mb-6">Security Settings</h2>
                <form onSubmit={handleSaveSecurity} className="space-y-6">
                  {/* Change Password */}
                  <div>
                    <h3 className="text-lg font-bold text-white mb-4">Change Password</h3>
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-400 mb-2">
                          Current Password
                        </label>
                        <input
                          type="password"
                          className="w-full bg-navy-dark text-white border border-gold/20 rounded-lg px-4 py-3 focus:outline-none focus:border-gold"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-400 mb-2">
                          New Password
                        </label>
                        <input
                          type="password"
                          className="w-full bg-navy-dark text-white border border-gold/20 rounded-lg px-4 py-3 focus:outline-none focus:border-gold"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-400 mb-2">
                          Confirm New Password
                        </label>
                        <input
                          type="password"
                          className="w-full bg-navy-dark text-white border border-gold/20 rounded-lg px-4 py-3 focus:outline-none focus:border-gold"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Two-Factor Authentication */}
                  <div className="border-t border-gold/10 pt-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-lg font-bold text-white mb-2">Two-Factor Authentication</h3>
                        <p className="text-sm text-gray-400">Add an extra layer of security to your account</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSecurityData({ ...securityData, twoFactorEnabled: !securityData.twoFactorEnabled })}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          securityData.twoFactorEnabled ? "bg-gold" : "bg-gray-600"
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            securityData.twoFactorEnabled ? "translate-x-6" : "translate-x-1"
                          }`}
                        />
                      </button>
                    </div>
                  </div>

                  {/* Biometric Authentication */}
                  <div className="border-t border-gold/10 pt-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-lg font-bold text-white mb-2">Biometric Authentication</h3>
                        <p className="text-sm text-gray-400">Use fingerprint or face recognition</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSecurityData({ ...securityData, biometricEnabled: !securityData.biometricEnabled })}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          securityData.biometricEnabled ? "bg-gold" : "bg-gray-600"
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            securityData.biometricEnabled ? "translate-x-6" : "translate-x-1"
                          }`}
                        />
                      </button>
                    </div>
                  </div>

                  {/* Save Button */}
                  <button
                    type="submit"
                    className="w-full md:w-auto px-6 py-3 bg-gradient-to-r from-gold to-gold-light text-navy font-bold rounded-lg hover:scale-105 transition-all duration-300"
                  >
                    Update Security
                  </button>
                </form>
              </div>

              {/* Active Sessions */}
              <div className="glass rounded-xl p-6 border border-gold/20">
                <h2 className="text-xl font-bold text-white mb-4">Active Sessions</h2>
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-4 bg-navy-dark rounded-lg border border-gold/10">
                    <div className="flex items-center gap-4">
                      <svg className="w-8 h-8 text-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                      </svg>
                      <div>
                        <div className="text-sm font-bold text-white">Chrome on MacOS</div>
                        <div className="text-xs text-gray-400">New York, US • Current session</div>
                      </div>
                    </div>
                    <span className="text-xs text-green-400 bg-green-400/10 px-3 py-1 rounded-full">Active</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Notifications Section */}
          {activeSection === "notifications" && (
            <div className="glass rounded-xl p-6 border border-gold/20">
              <h2 className="text-xl font-bold text-white mb-6">Notification Preferences</h2>
              <form onSubmit={handleSaveNotifications} className="space-y-6">
                <div className="space-y-4">
                  <div className="flex items-center justify-between py-3 border-b border-gold/10">
                    <div>
                      <div className="text-sm font-medium text-white">Email Notifications</div>
                      <div className="text-xs text-gray-400">Receive email updates</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setNotificationSettings({ ...notificationSettings, emailNotifications: !notificationSettings.emailNotifications })}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        notificationSettings.emailNotifications ? "bg-gold" : "bg-gray-600"
                      }`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        notificationSettings.emailNotifications ? "translate-x-6" : "translate-x-1"
                      }`} />
                    </button>
                  </div>

                  <div className="flex items-center justify-between py-3 border-b border-gold/10">
                    <div>
                      <div className="text-sm font-medium text-white">Investment Updates</div>
                      <div className="text-xs text-gray-400">Get notified about your investments</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setNotificationSettings({ ...notificationSettings, investmentUpdates: !notificationSettings.investmentUpdates })}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        notificationSettings.investmentUpdates ? "bg-gold" : "bg-gray-600"
                      }`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        notificationSettings.investmentUpdates ? "translate-x-6" : "translate-x-1"
                      }`} />
                    </button>
                  </div>

                  <div className="flex items-center justify-between py-3 border-b border-gold/10">
                    <div>
                      <div className="text-sm font-medium text-white">Dividend Payments</div>
                      <div className="text-xs text-gray-400">Alerts when you receive dividends</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setNotificationSettings({ ...notificationSettings, dividendPayments: !notificationSettings.dividendPayments })}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        notificationSettings.dividendPayments ? "bg-gold" : "bg-gray-600"
                      }`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        notificationSettings.dividendPayments ? "translate-x-6" : "translate-x-1"
                      }`} />
                    </button>
                  </div>

                  <div className="flex items-center justify-between py-3 border-b border-gold/10">
                    <div>
                      <div className="text-sm font-medium text-white">Project Updates</div>
                      <div className="text-xs text-gray-400">News about mining projects</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setNotificationSettings({ ...notificationSettings, projectUpdates: !notificationSettings.projectUpdates })}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        notificationSettings.projectUpdates ? "bg-gold" : "bg-gray-600"
                      }`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        notificationSettings.projectUpdates ? "translate-x-6" : "translate-x-1"
                      }`} />
                    </button>
                  </div>

                  <div className="flex items-center justify-between py-3 border-b border-gold/10">
                    <div>
                      <div className="text-sm font-medium text-white">Marketing Emails</div>
                      <div className="text-xs text-gray-400">Promotional content and offers</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setNotificationSettings({ ...notificationSettings, marketingEmails: !notificationSettings.marketingEmails })}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        notificationSettings.marketingEmails ? "bg-gold" : "bg-gray-600"
                      }`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        notificationSettings.marketingEmails ? "translate-x-6" : "translate-x-1"
                      }`} />
                    </button>
                  </div>

                  <div className="flex items-center justify-between py-3">
                    <div>
                      <div className="text-sm font-medium text-white">SMS Notifications</div>
                      <div className="text-xs text-gray-400">Text message alerts</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setNotificationSettings({ ...notificationSettings, smsNotifications: !notificationSettings.smsNotifications })}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        notificationSettings.smsNotifications ? "bg-gold" : "bg-gray-600"
                      }`}
                    >
                      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        notificationSettings.smsNotifications ? "translate-x-6" : "translate-x-1"
                      }`} />
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  className="w-full md:w-auto px-6 py-3 bg-gradient-to-r from-gold to-gold-light text-navy font-bold rounded-lg hover:scale-105 transition-all duration-300"
                >
                  Save Preferences
                </button>
              </form>
            </div>
          )}

          {/* Preferences Section */}
          {activeSection === "preferences" && (
            <div className="glass rounded-xl p-6 border border-gold/20">
              <h2 className="text-xl font-bold text-white mb-6">Application Preferences</h2>
              <form onSubmit={handleSavePreferences} className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-2">
                    Display Currency
                  </label>
                  <select
                    value={preferences.currency}
                    onChange={(e) => setPreferences({ ...preferences, currency: e.target.value })}
                    className="w-full bg-navy-dark text-white border border-gold/20 rounded-lg px-4 py-3 focus:outline-none focus:border-gold"
                  >
                    <option>USD</option>
                    <option>EUR</option>
                    <option>GBP</option>
                    <option>CAD</option>
                    <option>AUD</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-2">
                    Language
                  </label>
                  <select
                    value={preferences.language}
                    onChange={(e) => setPreferences({ ...preferences, language: e.target.value })}
                    className="w-full bg-navy-dark text-white border border-gold/20 rounded-lg px-4 py-3 focus:outline-none focus:border-gold"
                  >
                    <option>English</option>
                    <option>Spanish</option>
                    <option>French</option>
                    <option>German</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-2">
                    Theme
                  </label>
                  <select
                    value={preferences.theme}
                    onChange={(e) => setPreferences({ ...preferences, theme: e.target.value })}
                    className="w-full bg-navy-dark text-white border border-gold/20 rounded-lg px-4 py-3 focus:outline-none focus:border-gold"
                  >
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                    <option value="auto">Auto</option>
                  </select>
                </div>

                <button
                  type="submit"
                  className="w-full md:w-auto px-6 py-3 bg-gradient-to-r from-gold to-gold-light text-navy font-bold rounded-lg hover:scale-105 transition-all duration-300"
                >
                  Save Preferences
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
