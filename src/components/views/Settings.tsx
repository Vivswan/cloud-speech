import React, { useState } from 'react'
import { useSync } from '../../hooks/useSync'
import { Text } from '../inputs/Text'
import { Button } from '../buttons/Button'
import { Command, Key } from 'react-feather'

export function Settings() {
  const { ready: syncReady, sync, setSync } = useSync()
  const [credentialsValidating, setCredentialsValidating] = useState(false)
  const [credentialsError, setCredentialsError] = useState('')

  if (!syncReady) return null

  async function handleCredentialsValidation() {
    setCredentialsValidating(true)

    const voices = await chrome.runtime.sendMessage({ id: 'fetchVoices' })
    if (!voices) {
      setCredentialsError('AWS credentials are missing or invalid')
      setCredentialsValidating(false)
      return setSync({ ...sync, credentialsValid: false })
    }

    setSync({ ...sync, credentialsValid: true })
    setCredentialsValidating(false)
    setCredentialsError('')
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="font-semibold text-neutral-700 mb-1.5 ml-1 flex items-center">
          AWS Credentials
        </div>
        <div className="bg-white p-3 rounded shadow-sm border flex flex-col gap-2">
          <Text
            error={credentialsError}
            label="Access Key ID"
            placeholder="Ex: AKIAIOSFODNN7EXAMPLE"
            value={sync.accessKeyId}
            onChange={(accessKeyId) =>
              setSync({ ...sync, accessKeyId, credentialsValid: false })
            }
            type="password"
          />
          <Text
            label="Secret Access Key"
            placeholder="Ex: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
            value={sync.secretAccessKey}
            onChange={(secretAccessKey) =>
              setSync({ ...sync, secretAccessKey, credentialsValid: false })
            }
            type="password"
          />
          <Text
            label="Region"
            placeholder="Ex: us-east-1"
            value={sync.region}
            onChange={(region) =>
              setSync({ ...sync, region, credentialsValid: false })
            }
          />
          {!sync.credentialsValid && (
            <div className="w-fit ml-auto">
              <Button
                type="primary"
                Icon={Key}
                onClick={handleCredentialsValidation}
                submitting={credentialsValidating}
                ping={!sync.accessKeyId || !sync.secretAccessKey || !sync.region}
              >
                Validate credentials
              </Button>
            </div>
          )}
        </div>
      </div>
      <div className={!sync.credentialsValid ? 'opacity-50 pointer-events-none' : ''}>
        <div className="font-semibold text-neutral-700 mb-1.5 ml-1 flex items-center">
          Shortcuts
        </div>
        <div className="grid gap-4 grid-cols-2 bg-white p-3 rounded shadow-sm border">
          <Button
            type="primary"
            Icon={Command}
            onClick={() =>
              chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })
            }
          >
            Edit shortcuts
          </Button>
        </div>
      </div>
    </div>
  )
}