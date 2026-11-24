import './styles/tokens.css'
import './styles/reset.css'
import './styles/motion.css'
import { createRoot } from 'react-dom/client'
import Root from './app/Root.jsx'
import { mountPoint } from './platform/dom.js'
import { applyVisualPrefs, readVisualPrefs } from './platform/theme.js'

const host = mountPoint('harbor-app-root')
if (host) {
  applyVisualPrefs(readVisualPrefs())
  createRoot(host).render(<Root />)
}
