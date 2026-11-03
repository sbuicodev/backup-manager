import i18next from 'i18next'
import en from './en.json'

/**
 * Every label the app shows lives in a strings file per language (`en.json` for now). To change
 * wording, edit the file; to add a language, add a file and list it in `resources`.
 */
const i18n = i18next.createInstance()
void i18n.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
  initAsync: false
})

export const t = i18n.t.bind(i18n)
export default i18n
