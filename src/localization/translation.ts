import { useCallback, useEffect, useState } from 'react'
import enTranslations from './en.yaml'
import zhCNTranslations from './zh-CN.yaml'
import zhTWTranslations from './zh-TW.yaml'
import hiTranslations from './hi.yaml'

type TranslationKey = string
type TranslationParams = Record<string, string | number>
type Translations = Record<string, any>

interface TranslationContext {
  t: (key: TranslationKey, params?: TranslationParams) => string
  locale: string
  setLocale: (locale: string) => void
  availableLocales: string[]
}

const DEFAULT_LOCALE = 'en'
const STORAGE_KEY = 'polly_locale'

// Translation modules - add more languages here
const translationModules: Record<string, Translations> = {
  en: enTranslations,
  'zh-CN': zhCNTranslations,
  'zh-TW': zhTWTranslations,
  hi: hiTranslations
}

let cachedTranslations: Record<string, Translations> = {
  en: enTranslations,
  'zh-CN': zhCNTranslations,
  'zh-TW': zhTWTranslations,
  hi: hiTranslations
}
let currentLocale = DEFAULT_LOCALE

// Global state for forcing updates across all components
let globalUpdateCounter = 0
const subscribers = new Set<() => void>()

const notifySubscribers = () => {
  globalUpdateCounter++
  subscribers.forEach(callback => callback())
}

const getNestedValue = (obj: any, path: string): string => {
  const keys = path.split('.')
  let result = obj

  for (const key of keys) {
    if (result && typeof result === 'object' && key in result) {
      result = result[key]
    } else {
      return path // Return key as fallback
    }
  }

  return typeof result === 'string' ? result : path
}

const interpolateString = (template: string, params?: TranslationParams): string => {
  if (!params) return template

  return template.replace(/{{(\w+)}}/g, (match, key) => {
    return params[key]?.toString() || match
  })
}

const loadTranslations = (locale: string): Translations => {
  if (cachedTranslations[locale]) {
    return cachedTranslations[locale]
  }

  const translations = translationModules[locale]
  if (translations) {
    cachedTranslations[locale] = translations
    return translations
  }

  // Fallback to English if locale not found
  if (locale !== DEFAULT_LOCALE) {
    console.warn(`Translations for locale '${locale}' not found, falling back to English`)
    return cachedTranslations[DEFAULT_LOCALE] || {}
  }

  return {}
}

const translate = (key: TranslationKey, params?: TranslationParams, locale?: string): string => {
  const targetLocale = locale || currentLocale
  const translations = loadTranslations(targetLocale)

  let translated = getNestedValue(translations, key)

  // Fallback to English if translation not found and not already using English
  if (translated === key && targetLocale !== DEFAULT_LOCALE) {
    const englishTranslations = loadTranslations(DEFAULT_LOCALE)
    translated = getNestedValue(englishTranslations, key)
  }

  return interpolateString(translated, params)
}

const getStoredLocale = (): string => {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

const setStoredLocale = (locale: string): void => {
  try {
    localStorage.setItem(STORAGE_KEY, locale)
  } catch (error) {
    console.warn('Failed to store locale preference:', error)
  }
}

export const getLanguageDisplayName = (code: string): string => {
  const languageNames: Record<string, string> = {
    'en': 'English',
    'zh-CN': '简体中文',
    'zh-TW': '繁體中文',
    'hi': 'हिन्दी'
  }
  return languageNames[code] || code.toUpperCase()
}

export const useTranslation = (): TranslationContext => {
  const [locale, setLocaleState] = useState<string>(getStoredLocale())
  const [updateTrigger, setUpdateTrigger] = useState<number>(0)

  useEffect(() => {
    currentLocale = locale
    // Preload translations for the current locale
    loadTranslations(locale)
  }, [locale])

  // Subscribe to global updates
  useEffect(() => {
    const handleUpdate = () => {
      setUpdateTrigger(globalUpdateCounter)
      setLocaleState(currentLocale) // Keep local state in sync for return value
    }

    subscribers.add(handleUpdate)

    return () => {
      subscribers.delete(handleUpdate)
    }
  }, [])

  const t = useCallback((key: TranslationKey, params?: TranslationParams): string => {
    return translate(key, params, currentLocale) // Use global currentLocale directly
  }, [updateTrigger])

  const setLocale = useCallback((newLocale: string) => {
    // Only allow locales that we have translations for
    if (!translationModules[newLocale]) {
      console.warn(`Locale '${newLocale}' is not available`)
      return
    }

    setStoredLocale(newLocale)
    setLocaleState(newLocale)
    currentLocale = newLocale

    // Notify all subscribers to update
    notifySubscribers()
  }, [])

  return {
    t,
    locale,
    setLocale,
    availableLocales: Object.keys(translationModules)
  }
}

export { translate }
export type { TranslationKey, TranslationParams, TranslationContext }