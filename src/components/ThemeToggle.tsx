'use client'
import { useSyncExternalStore } from 'react'

const THEME_CHANGE_EVENT = 'plextech:theme-change'

function subscribeToTheme(onStoreChange: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === 'theme') onStoreChange()
  }
  window.addEventListener('storage', handleStorage)
  window.addEventListener(THEME_CHANGE_EVENT, onStoreChange)
  return () => {
    window.removeEventListener('storage', handleStorage)
    window.removeEventListener(THEME_CHANGE_EVENT, onStoreChange)
  }
}

function getThemeSnapshot() {
  return localStorage.getItem('theme') === 'dark'
}

function getServerThemeSnapshot() {
  return false
}

function applyTheme(dark: boolean) {
  const el = document.documentElement
  el.setAttribute('data-theme', dark ? 'dark' : 'light')
  if (dark) {
    el.style.setProperty('--bg-base',        '#140f18')
    el.style.setProperty('--bg-surface',     '#1d1623')
    el.style.setProperty('--bg-raised',      '#2a1f31')
    el.style.setProperty('--bg-active',      '#3b2a45')
    el.style.setProperty('--border',         '#403247')
    el.style.setProperty('--text-primary',   '#fff8f3')
    el.style.setProperty('--text-secondary', '#e7dce9')
    el.style.setProperty('--text-muted',     '#a99dac')
  } else {
    el.style.setProperty('--bg-base',        '#fffaf6')
    el.style.setProperty('--bg-surface',     '#ffffff')
    el.style.setProperty('--bg-raised',      '#fff3ec')
    el.style.setProperty('--bg-active',      '#ffe5d7')
    el.style.setProperty('--border',         '#eadfd8')
    el.style.setProperty('--text-primary',   '#241b2b')
    el.style.setProperty('--text-secondary', '#514759')
    el.style.setProperty('--text-muted',     '#7d7282')
  }
}

export default function ThemeToggle() {
  const isDark = useSyncExternalStore(
    subscribeToTheme,
    getThemeSnapshot,
    getServerThemeSnapshot,
  )

  function toggle() {
    const next = !isDark
    localStorage.setItem('theme', next ? 'dark' : 'light')
    applyTheme(next)
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT))
  }

  return (
    <button
      onClick={toggle}
      title={isDark ? 'Light mode' : 'Dark mode'}
      className="w-8 h-8 flex items-center justify-center rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--bg-active)] transition-colors"
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </button>
  )
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5"/>
      <line x1="12" y1="1" x2="12" y2="3"/>
      <line x1="12" y1="21" x2="12" y2="23"/>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
      <line x1="1" y1="12" x2="3" y2="12"/>
      <line x1="21" y1="12" x2="23" y2="12"/>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
    </svg>
  )
}
