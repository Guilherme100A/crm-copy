// Área dos toasts (Base UI Toast) no canto da tela; cada toast leva `data-testid` = seu `type`.
import { Toast } from '@base-ui/react/toast'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useT } from '@/i18n'
import { toastManager } from '@/lib/toast'

function ToastList() {
  const { toasts } = Toast.useToastManager()
  const t = useT()
  return (
    <Toast.Portal>
      <Toast.Viewport className="fixed bottom-20 left-1/2 z-[100] flex w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2 lg:right-4 lg:bottom-4 lg:left-auto lg:translate-x-0">
        {toasts.map((toast) => (
          <Toast.Root
            key={toast.id}
            toast={toast}
            data-testid={toast.type || 'toast'}
            className="flex items-start gap-3 rounded-lg border border-warning/50 bg-popover p-3 text-sm text-popover-foreground shadow-lg"
          >
            <div className="flex-1">
              <Toast.Title className="font-medium">{toast.title}</Toast.Title>
              {toast.description ? <Toast.Description className="text-muted-foreground">{toast.description}</Toast.Description> : null}
            </div>
            <Toast.Close aria-label={t('sidebar.closeMenu')} className="rounded p-1 hover:bg-accent">
              <X className="size-4" />
            </Toast.Close>
          </Toast.Root>
        ))}
      </Toast.Viewport>
    </Toast.Portal>
  )
}

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider toastManager={toastManager} timeout={6000} limit={3}>
      {children}
      <ToastList />
    </Toast.Provider>
  )
}
