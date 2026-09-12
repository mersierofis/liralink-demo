import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import App from './App'

describe('App', () => {
  it('boots and shows the placeholder shell', () => {
    render(<App />)
    expect(screen.getByText('LiraLink — merchant-web')).toBeInTheDocument()
  })
})
