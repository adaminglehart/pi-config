init:
    chezmoi init --source ~/dev/pi-config --apply=false

apply:
    chezmoi apply

diff:
    chezmoi diff

# Generate honcho .env file for the current environment
honcho-env:
    @echo "Generating honcho/.env for current environment..."
    @chezmoi execute-template < honcho/.env.tmpl > honcho/.env
    @echo "✓ honcho/.env generated"
