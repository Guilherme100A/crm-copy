// `/`: a guarda da raiz manda para a home do papel (spec 18 §5.2); nada é renderizado aqui.
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: () => null,
})
