import { useTranslation } from 'react-i18next'
import PropTypes from 'prop-types'
import { useLayoutEffect, useState } from 'react'
import { PencilIcon, TrashIcon, PlusIcon } from '@primer/octicons-react'

CustomProviders.propTypes = {
  config: PropTypes.object.isRequired,
  updateConfig: PropTypes.func.isRequired,
}

const defaultProvider = {
  id: '',
  name: '',
  baseUrl: 'http://localhost:8000/v1/chat/completions',
  apiKey: '',
  active: true,
  models: [
    {
      name: 'gpt-4',
      displayName: 'GPT-4',
      active: true,
    },
  ],
}

const defaultModel = {
  name: '',
  displayName: '',
  active: true,
}

export function CustomProviders({ config, updateConfig }) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [editingProvider, setEditingProvider] = useState(defaultProvider)
  const [editingIndex, setEditingIndex] = useState(-1)
  const [providers, setProviders] = useState([])

  useLayoutEffect(() => {
    const customProviders = config.customProviders || []
    setProviders(customProviders)
  }, [config.customProviders])

  const generateProviderId = (name) => {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + Date.now()
  }

  const saveProvider = () => {
    const updatedProviders = [...providers]

    if (editingIndex === -1) {
      // Adding new provider
      const newProvider = {
        ...editingProvider,
        id: editingProvider.id || generateProviderId(editingProvider.name),
      }
      updatedProviders.push(newProvider)
    } else {
      // Editing existing provider
      updatedProviders[editingIndex] = editingProvider
    }

    updateConfig({ customProviders: updatedProviders })
    setEditing(false)
    setEditingProvider(defaultProvider)
    setEditingIndex(-1)
  }

  const deleteProvider = (index) => {
    const updatedProviders = [...providers]
    updatedProviders.splice(index, 1)
    updateConfig({ customProviders: updatedProviders })
  }

  const toggleProviderActive = (index) => {
    const updatedProviders = [...providers]
    updatedProviders[index] = {
      ...updatedProviders[index],
      active: !updatedProviders[index].active,
    }
    updateConfig({ customProviders: updatedProviders })
  }

  const addModel = () => {
    setEditingProvider({
      ...editingProvider,
      models: [...editingProvider.models, { ...defaultModel }],
    })
  }

  const updateModel = (modelIndex, field, value) => {
    const updatedModels = [...editingProvider.models]
    updatedModels[modelIndex] = { ...updatedModels[modelIndex], [field]: value }
    setEditingProvider({ ...editingProvider, models: updatedModels })
  }

  const removeModel = (modelIndex) => {
    const updatedModels = editingProvider.models.filter((_, index) => index !== modelIndex)
    setEditingProvider({ ...editingProvider, models: updatedModels })
  }

  const editingComponent = (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '12px',
        border: '1px solid #ccc',
        borderRadius: '4px',
      }}
    >
      <div style={{ display: 'flex', gap: '12px' }}>
        <button
          onClick={() => {
            setEditing(false)
            setEditingProvider(defaultProvider)
            setEditingIndex(-1)
          }}
        >
          {t('Cancel')}
        </button>
        <button onClick={saveProvider}>
          {editingIndex === -1 ? t('Add Provider') : t('Save Provider')}
        </button>
      </div>

      <input
        type="text"
        value={editingProvider.name}
        placeholder={t('Provider Name (e.g., "OpenRouter", "LocalAI")')}
        onChange={(e) => setEditingProvider({ ...editingProvider, name: e.target.value })}
      />

      <input
        type="text"
        value={editingProvider.baseUrl}
        placeholder={t('Base URL (e.g., "https://openrouter.ai/api/v1/chat/completions")')}
        onChange={(e) => setEditingProvider({ ...editingProvider, baseUrl: e.target.value })}
      />

      <input
        type="password"
        value={editingProvider.apiKey}
        placeholder={t('API Key')}
        onChange={(e) => setEditingProvider({ ...editingProvider, apiKey: e.target.value })}
      />

      <div style={{ marginTop: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
          <strong>{t('Models')}</strong>
          <button onClick={addModel} style={{ fontSize: '12px', padding: '2px 6px' }}>
            <PlusIcon size={12} /> {t('Add Model')}
          </button>
        </div>

        {editingProvider.models.map((model, modelIndex) => (
          <div
            key={modelIndex}
            style={{ display: 'flex', gap: '8px', marginBottom: '4px', alignItems: 'center' }}
          >
            <input
              type="text"
              value={model.name}
              placeholder={t('Model Name (e.g., "gpt-4", "claude-3")')}
              onChange={(e) => updateModel(modelIndex, 'name', e.target.value)}
              style={{ flex: 1 }}
            />
            <input
              type="text"
              value={model.displayName}
              placeholder={t('Display Name (e.g., "GPT-4", "Claude 3")')}
              onChange={(e) => updateModel(modelIndex, 'displayName', e.target.value)}
              style={{ flex: 1 }}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}>
              <input
                type="checkbox"
                checked={model.active}
                onChange={(e) => updateModel(modelIndex, 'active', e.target.checked)}
              />
              {t('Active')}
            </label>
            <button
              onClick={() => removeModel(modelIndex)}
              style={{ fontSize: '12px', padding: '2px 6px' }}
            >
              <TrashIcon size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <div>
      <h3>{t('Custom Providers')}</h3>
      <p style={{ fontSize: '14px', color: '#666', marginBottom: '12px' }}>
        {t(
          'Manage OpenAI-compatible API providers. Each provider can have multiple models sharing the same API key and base URL.',
        )}
      </p>

      {providers.map((provider, index) => (
        <div key={index} style={{ marginBottom: '8px' }}>
          {editing && editingIndex === index ? (
            editingComponent
          ) : (
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="checkbox"
                checked={provider.active}
                onChange={() => toggleProviderActive(index)}
              />
              <div style={{ flex: 1 }}>
                <strong>{provider.name}</strong>
                <div style={{ fontSize: '12px', color: '#666' }}>
                  {provider.models?.filter((m) => m.active).length || 0} active models •{' '}
                  {provider.baseUrl}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <div
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    setEditing(true)
                    setEditingProvider(provider)
                    setEditingIndex(index)
                  }}
                >
                  <PencilIcon size={16} />
                </div>
                <div style={{ cursor: 'pointer' }} onClick={() => deleteProvider(index)}>
                  <TrashIcon size={16} />
                </div>
              </div>
            </label>
          )}
        </div>
      ))}

      {editing && editingIndex === -1 && editingComponent}

      {!editing && (
        <button
          onClick={() => {
            setEditing(true)
            setEditingProvider({ ...defaultProvider })
            setEditingIndex(-1)
          }}
          style={{ marginTop: '8px' }}
        >
          {t('Add New Provider')}
        </button>
      )}
    </div>
  )
}
