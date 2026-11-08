import { Children, Fragment, forwardRef, isValidElement, useCallback, useEffect, useId, useMemo, useRef, useState, type ButtonHTMLAttributes, type ChangeEvent, type FormEvent, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type SelectHTMLAttributes } from 'react'
import { Link, type LinkProps } from 'react-router-dom'
import { Check, ChevronDown, ChevronRight } from 'lucide-react'

type ButtonVariant = 'primary' | 'secondary' | 'icon' | 'danger'
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }

const buttonClass: Record<ButtonVariant, string> = {
  primary: 'primary-button',
  secondary: 'secondary-button',
  icon: 'icon-button',
  danger: 'confirm-danger-button',
}

/** Shared button surface; existing class names keep the app's established theme. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, className = '', ...props }, ref,
) {
  const resolvedClass = variant ? `${buttonClass[variant]} ${className}`.trim() : className
  return <button ref={ref} className={resolvedClass || undefined} {...props} />
})

export type IconButtonProps = Omit<ButtonProps, 'children' | 'variant'> & { label: string; children: ReactNode }

/** Icon-only actions always carry a screen-reader name. */
export function IconButton({ label, children, ...props }: IconButtonProps) {
  return <Button {...props} variant="icon" aria-label={label}>{children}</Button>
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  props, ref,
) {
  return <input ref={ref} {...props} />
})

type DropdownProps = SelectHTMLAttributes<HTMLSelectElement> & { placeholder?: string }
type DropdownOption = { value: string; label: string; disabled: boolean; group?: string }

function readOptions(children: ReactNode, group?: string): DropdownOption[] {
  const options: DropdownOption[] = []
  Children.forEach(children, child => {
    if (!isValidElement(child)) return
    if (child.type === Fragment) {
      options.push(...readOptions((child.props as { children?: ReactNode }).children, group))
    } else if (child.type === 'option') {
      const props = child.props as { value?: string | number; disabled?: boolean; children?: ReactNode }
      const label = Children.toArray(props.children).map(part => typeof part === 'string' || typeof part === 'number' ? String(part) : '').join('').trim()
      options.push({ value: String(props.value ?? label), label, disabled: Boolean(props.disabled), group })
    } else if (child.type === 'optgroup') {
      const props = child.props as { label?: string; children?: ReactNode }
      options.push(...readOptions(props.children, props.label))
    }
  })
  return options
}

/** Branded listbox backed by a native select for form submission and validation. */
export const Dropdown = forwardRef<HTMLSelectElement, DropdownProps>(function Dropdown(props, forwardedRef) {
  const {
    id, name, value, defaultValue, children, className = '', placeholder,
    disabled = false, required = false, autoFocus, onChange, onInvalid,
    'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledBy,
    'aria-describedby': ariaDescribedBy, 'aria-invalid': ariaInvalid,
    ...nativeProps
  } = props
  const generatedId = useId()
  const triggerId = id ?? generatedId
  const listId = `${triggerId}-listbox`
  const optionRows = useMemo(() => readOptions(children), [children])
  const initialValue = String(value ?? defaultValue ?? optionRows.find(option => !option.disabled)?.value ?? '')
  const [uncontrolledValue, setUncontrolledValue] = useState(initialValue)
  const selectedValue = value === undefined ? uncontrolledValue : String(value)
  const selectedIndex = optionRows.findIndex(option => option.value === selectedValue)
  const selectedLabel = optionRows[selectedIndex]?.label ?? ''
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(Math.max(0, selectedIndex))
  const [detectedLabelId, setDetectedLabelId] = useState('')
  const shellRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const nativeRef = useRef<HTMLSelectElement>(null)
  const typeaheadRef = useRef('')
  const typeaheadTimerRef = useRef<number | undefined>(undefined)

  const attachNativeRef = useCallback((node: HTMLSelectElement | null) => {
    nativeRef.current = node
    if (typeof forwardedRef === 'function') forwardedRef(node)
    else if (forwardedRef) forwardedRef.current = node
  }, [forwardedRef])

  useEffect(() => {
    if (!id) return
    const label = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`)
    if (!label) return
    if (!label.id) label.id = `${triggerId}-label`
    setDetectedLabelId(label.id)
    const focusTrigger = () => triggerRef.current?.focus()
    label.addEventListener('click', focusTrigger)
    return () => label.removeEventListener('click', focusTrigger)
  }, [id, triggerId])

  useEffect(() => {
    function closeOnOutsidePointer(event: PointerEvent) {
      if (event.target instanceof Node && !shellRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [])

  useEffect(() => () => window.clearTimeout(typeaheadTimerRef.current), [])

  function enabledIndex(start: number, direction: 1 | -1) {
    if (!optionRows.length) return -1
    let index = (start + optionRows.length) % optionRows.length
    for (let count = 0; count < optionRows.length; count += 1) {
      if (!optionRows[index]?.disabled) return index
      index = (index + direction + optionRows.length) % optionRows.length
    }
    return -1
  }

  function openAt(index = selectedIndex) {
    setActiveIndex(enabledIndex(index >= 0 ? index : 0, 1))
    setOpen(true)
  }

  function choose(option: DropdownOption) {
    if (option.disabled || disabled) return
    setUncontrolledValue(option.value)
    const select = nativeRef.current
    if (select && select.value !== option.value) {
      select.value = option.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }
    setOpen(false)
    triggerRef.current?.focus()
  }

  function handleNativeChange(event: ChangeEvent<HTMLSelectElement>) {
    if (props.value === undefined) setUncontrolledValue(event.currentTarget.value)
    onChange?.(event)
  }

  function handleInvalid(event: FormEvent<HTMLSelectElement>) {
    onInvalid?.(event)
    event.preventDefault()
    openAt()
    triggerRef.current?.focus()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) openAt(selectedIndex < 0 ? 0 : enabledIndex(selectedIndex + (event.key === 'ArrowDown' ? 1 : -1), event.key === 'ArrowDown' ? 1 : -1))
      else setActiveIndex(current => enabledIndex(current + (event.key === 'ArrowDown' ? 1 : -1), event.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (!open && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      openAt()
      return
    }
    if (open && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      const option = optionRows[activeIndex]
      if (option) choose(option)
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
      return
    }
    if (event.key === 'Tab' && open) {
      setOpen(false)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      if (!open) setOpen(true)
      setActiveIndex(enabledIndex(event.key === 'Home' ? 0 : optionRows.length - 1, event.key === 'Home' ? 1 : -1))
      return
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      typeaheadRef.current += event.key.toLocaleLowerCase()
      window.clearTimeout(typeaheadTimerRef.current)
      typeaheadTimerRef.current = window.setTimeout(() => { typeaheadRef.current = '' }, 600)
      const match = optionRows.findIndex(option => !option.disabled && option.label.toLocaleLowerCase().startsWith(typeaheadRef.current))
      if (match >= 0) {
        if (open) setActiveIndex(match)
        else if (optionRows[match]) choose(optionRows[match])
      }
    }
  }

  const labelId = ariaLabelledBy ?? (detectedLabelId || undefined)
  const currentLabel = selectedLabel

  return (
    <div ref={shellRef} className={`shared-dropdown-shell ${className}`.trim()}>
      <select
        {...nativeProps}
        ref={attachNativeRef}
        id={`${triggerId}-native`}
        name={name}
        value={selectedValue}
        disabled={disabled}
        required={required}
        onChange={handleNativeChange}
        onInvalid={handleInvalid}
        tabIndex={-1}
        aria-hidden="true"
        className="shared-dropdown-native"
      >{children}</select>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        className="shared-dropdown-trigger"
        disabled={disabled}
        autoFocus={autoFocus}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined}
        aria-label={ariaLabel ?? (labelId ? undefined : placeholder)}
        aria-labelledby={labelId}
        aria-describedby={ariaDescribedBy}
        aria-required={required || undefined}
        aria-invalid={ariaInvalid}
        onClick={() => open ? setOpen(false) : openAt()}
        onKeyDown={handleKeyDown}
      >
        <span className={currentLabel ? 'shared-dropdown-value' : 'shared-dropdown-placeholder'}>{currentLabel || placeholder || 'Chọn một mục'}</span>
        <ChevronDown size={17} aria-hidden="true" />
      </button>
      {open && <div id={listId} className="shared-dropdown-listbox" role="listbox" aria-labelledby={labelId}>
        {optionRows.map((option, index) => (
          <div
            key={`${option.group ?? ''}:${option.value}:${index}`}
            id={`${listId}-option-${index}`}
            role="option"
            aria-selected={option.value === (value === undefined ? uncontrolledValue : selectedValue)}
            aria-disabled={option.disabled || undefined}
            className={`shared-dropdown-option${option.value === (value === undefined ? uncontrolledValue : selectedValue) ? ' is-selected' : ''}${index === activeIndex ? ' is-active' : ''}${option.disabled ? ' is-disabled' : ''}`}
            onMouseEnter={() => setActiveIndex(index)}
            onMouseDown={event => event.preventDefault()}
            onClick={() => choose(option)}
          >
            {option.group && <small>{option.group}</small>}
            <span>{option.label}</span>
            {option.value === (value === undefined ? uncontrolledValue : selectedValue) && <Check size={16} aria-hidden="true" />}
          </div>
        ))}
      </div>}
    </div>
  )
})

export const Textarea = forwardRef<HTMLTextAreaElement, import('react').TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  props, ref,
) {
  return <textarea ref={ref} {...props} />
})

type MenuLinkProps = Omit<LinkProps, 'to'> & {
  to: string
  icon: ReactNode
  title: string
  description: string
  tone: string
}

/** Reusable destination row for the More menu and future grouped navigation. */
export function MenuLink({ to, icon, title, description, tone, className = '', ...props }: MenuLinkProps) {
  return (
    <Link to={to} className={`menu-item ${className}`.trim()} {...props}>
      <span className={`menu-item-icon ${tone}`}>{icon}</span>
      <span className="menu-item-content"><strong>{title}</strong><small>{description}</small></span>
      <ChevronRight size={18} className="menu-item-arrow" aria-hidden="true" />
    </Link>
  )
}
