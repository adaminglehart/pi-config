init:
    chezmoi --config ~/.config/chezmoi-piconfig/chezmoi.yaml init

apply:
    chezmoi --config ~/.config/chezmoi-piconfig/chezmoi.yaml apply

diff:
    chezmoi --config ~/.config/chezmoi-piconfig/chezmoi.yaml diff

# Generate honcho .env file for the current environment
honcho-env:
    @echo "Generating honcho/.env for current environment..."
    @chezmoi --config ~/.config/chezmoi-piconfig/chezmoi.yaml execute-template < honcho/.env.tmpl > honcho/.env
    @echo "✓ honcho/.env generated"
