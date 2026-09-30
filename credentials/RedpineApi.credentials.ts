import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class RedpineApi implements ICredentialType {
	name = 'redpineApi';

	displayName = 'Redpine API';

	icon: Icon = { light: 'file:redpine.svg', dark: 'file:redpine.dark.svg' };

	documentationUrl = 'https://github.com/redpine-ai/n8n-nodes-redpine#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			placeholder: 'sk_live_...',
			description: 'Create one in the Redpine dashboard under Settings > API Keys',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// Free: reads the key's query quota and never touches the credit balance.
	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://api.redpine.ai',
			url: '/api/v1/search/quota',
			method: 'GET',
		},
	};
}
