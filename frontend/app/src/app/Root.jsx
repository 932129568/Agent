import { StrictMode } from 'react'
import ErrorBoundary from '../ui/ErrorBoundary.jsx'
import App from './App.jsx'

export default function Root() {
  return (
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>
  )
}
