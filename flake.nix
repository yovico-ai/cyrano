{
  description = "cyrano: Agda spec toolchain (the spec compiles to the conformance oracle)";

  # Same toolchain as yovico-ai/agda-guardrails (spec-oracle skill):
  # Agda with its standard library, and GHC to compile the oracle. Go and
  # Node come from the host (go/src/go.mod and ts/client/package.json pin them).
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ] (system:
      let
        pkgs = import nixpkgs { inherit system; };
        agdaWithStdlib = pkgs.agda.withPackages (p: [ p.standard-library ]);
      in
      {
        # No C compiler wrapper: Go and the TS tests build with the host
        # toolchain; this shell only adds what the spec needs.
        devShells.default = pkgs.mkShellNoCC {
          buildInputs = [ agdaWithStdlib pkgs.ghc pkgs.gnumake ];
          # Host LD_LIBRARY_PATH (CUDA etc.) shadows nix's glibc otherwise.
          shellHook = "unset LD_LIBRARY_PATH";
        };
      });
}
